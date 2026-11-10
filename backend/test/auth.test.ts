import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { BcryptPasswordHasher } from '../src/modules/auth/password.hasher.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { SessionStore, SESSION_TTL_MS } from '../src/modules/auth/session.store.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { createLoginRateLimiter } from '../src/middleware/loginRateLimiter.js';
import type { User } from '../src/generated/prisma/client.js';
import type { UserRepository } from '../src/modules/users/users.repository.js';

const password = 'initial-password-123';
const changedPassword = 'replacement-password-456';

async function fixture(options: { production?: boolean; ipLimit?: number; emailLimit?: number } = {}) {
  let time = Date.now();
  const hasher = new BcryptPasswordHasher(4);
  const user: User = { id: 'test-user', email: 'user@example.com', passwordHash: await hasher.hash(password),
    role: 'user', isActive: true, mustChangePassword: true, createdAt: new Date(), lastLoginAt: null };
  const users: UserRepository = {
    async findById(id) { return id === user.id ? user : null; },
    async findByEmail(email) { return email === user.email ? user : null; },
    async setLastLogin() { user.lastLoginAt = new Date(); },
    async changePassword(_id, hash) { user.passwordHash = hash; user.mustChangePassword = false; },
  };
  const audit: Array<{ userId: string; action: string }> = [];
  const sessions = new SessionStore(() => time);
  const auth = new AuthService(users, hasher, new AuditService({ async insert(userId, action) { audit.push({ userId, action }); } }), sessions);
  const server = createApp({ users, auth, sessions, production: options.production ?? false, cookieSecret: 's'.repeat(48),
    loginLimiter: createLoginRateLimiter({ ipLimit: options.ipLimit ?? 100, emailLimit: options.emailLimit ?? 100, now: () => time }) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown = {}, cookie = '') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  const login = () => post('/auth/login', { email: user.email, password });
  return { user, users, hasher, audit, sessions, post, login, base,
    advance(ms: number) { time += ms; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function cookie(response: Response) { return response.headers.get('set-cookie')!.split(';')[0]; }

test('bcrypt hashes are salted, verifiable, and reject passwords above 72 UTF-8 bytes', async () => {
  const hasher = new BcryptPasswordHasher(4);
  const first = await hasher.hash(password);
  assert.notEqual(first, await hasher.hash(password));
  assert.equal(await hasher.verify(password, first), true);
  assert.equal(await hasher.verify('incorrect', first), false);
  await assert.rejects(hasher.hash('é'.repeat(37)));
});

test('session IDs are random and expire at exactly eight hours', () => {
  let now = 0;
  const sessions = new SessionStore(() => now);
  const first = sessions.create('user');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, sessions.create('user'));
  now = SESSION_TTL_MS - 1;
  assert.equal(sessions.get(first)?.userId, 'user');
  now++;
  assert.equal(sessions.get(first), undefined);
});

test('all credential failures use the identical message, including disabled users and malformed JSON', async () => {
  const f = await fixture();
  try {
    for (const body of [{email: 'missing@example.com', password}, {email: f.user.email, password: 'wrong'}, {}, {email: f.user.email, password: 'x'.repeat(73)}]) {
      const response = await f.post('/auth/login', body);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {message: 'wrong email or password'});
      assert.equal(response.headers.get('set-cookie'), null);
    }
    f.user.isActive = false;
    assert.deepEqual(await (await f.login()).json(), {message: 'wrong email or password'});
    const malformed = await fetch(f.base + '/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'});
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {message: 'wrong email or password'});
    assert.equal(f.audit.length, 0);
  } finally { await f.close(); }
});

test('login sets the cookie, updates last login, excludes hashes, and logout revokes the session and audits both actions', async () => {
  const f = await fixture();
  try {
    const login = await f.post('/auth/login', {email: ' USER@EXAMPLE.COM ', password});
    assert.equal(login.status, 200);
    const header = login.headers.get('set-cookie')!;
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Max-Age=28800/);
    assert.doesNotMatch(header, /; Secure/);
    const result = await login.json() as {user: Record<string, unknown>};
    assert.equal(result.user.mustChangePassword, true);
    assert.equal('passwordHash' in result.user, false);
    assert.ok(f.user.lastLoginAt);
    const logout = await f.post('/auth/logout', {}, cookie(login));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
    assert.equal((await f.post('/auth/logout', {}, cookie(login))).status, 401);
    assert.deepEqual(f.audit.map(entry => entry.action), ['login', 'logout']);
  } finally { await f.close(); }
});

test('production cookies are Secure and a replacement login rotates the current session', async () => {
  const f = await fixture({production: true});
  try {
    const first = await f.login();
    assert.match(first.headers.get('set-cookie')!, /; Secure/);
    const next = await f.post('/auth/login', {email: f.user.email, password}, cookie(first));
    assert.notEqual(cookie(first), cookie(next));
    assert.equal((await f.post('/auth/logout', {}, cookie(first))).status, 401);
    assert.equal((await f.post('/auth/logout', {}, cookie(next))).status, 200);
  } finally { await f.close(); }
});

test('middleware rejects absent, tampered, expired, inactive and deleted users', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/auth/change-password')).status, 401);
    assert.equal((await f.post('/auth/logout', {}, 'session=forged')).status, 401);
    const first = await f.login();
    const firstCookie = cookie(first);
    assert.equal((await f.post('/auth/logout', {}, firstCookie + 'tampered')).status, 401);
    f.advance(SESSION_TTL_MS);
    assert.equal((await f.post('/auth/logout', {}, firstCookie)).status, 401);
    const second = await f.login();
    f.user.isActive = false;
    assert.equal((await f.post('/auth/logout', {}, cookie(second))).status, 401);
    f.user.isActive = true;
    assert.equal((await f.post('/auth/logout', {}, cookie(second))).status, 401);
    const third = await f.login();
    f.users.findById = async () => null;
    assert.equal((await f.post('/auth/logout', {}, cookie(third))).status, 401);
  } finally { await f.close(); }
});

test('password change verifies the current password, clears the flag and revokes every session', async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    const second = await f.login();
    assert.equal((await f.post('/auth/change-password', {currentPassword: 'incorrect', newPassword: changedPassword}, cookie(first))).status, 400);
    assert.equal((await f.post('/auth/change-password', {currentPassword: password, newPassword: 'short'}, cookie(first))).status, 400);
    assert.equal((await f.post('/auth/change-password', {currentPassword: password, newPassword: password}, cookie(first))).status, 400);
    const changed = await f.post('/auth/change-password', {currentPassword: password, newPassword: changedPassword}, cookie(first));
    assert.equal(changed.status, 200);
    assert.equal(f.user.mustChangePassword, false);
    assert.equal((await f.post('/auth/logout', {}, cookie(first))).status, 401);
    assert.equal((await f.post('/auth/logout', {}, cookie(second))).status, 401);
    assert.equal((await f.login()).status, 401);
    assert.equal((await f.post('/auth/login', {email: f.user.email, password: changedPassword})).status, 200);
  } finally { await f.close(); }
});

test('rate limiter limits normalized emails and resets after its window', async () => {
  const f = await fixture({emailLimit: 2});
  try {
    for (const email of ['user@example.com', ' USER@EXAMPLE.COM ']) {
      assert.equal((await f.post('/auth/login', {email, password: 'wrong'})).status, 401);
    }
    const limited = await f.login();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '900');
    assert.deepEqual(await limited.json(), {message: 'wrong email or password'});
    assert.equal((await f.post('/auth/login', {email: 'different@example.com', password})).status, 401);
    f.advance(15 * 60 * 1000);
    assert.equal((await f.login()).status, 200);
  } finally { await f.close(); }
});

test('rate limiter limits an IP across different emails and ignores spoofed forwarded addresses', async () => {
  const f = await fixture({ipLimit: 2});
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(f.base + '/auth/login', {method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i}`,
      }, body: JSON.stringify({email: `user${i}@example.com`, password})});
      assert.equal(response.status, i === 2 ? 429 : 401);
    }
  } finally { await f.close(); }
});
