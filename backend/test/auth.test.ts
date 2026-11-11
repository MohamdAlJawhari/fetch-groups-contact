import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { BcryptPasswordHasher } from '../src/modules/auth/password.hasher.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { SessionStore, SESSION_TTL_MS } from '../src/modules/auth/session.store.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { createLoginRateLimiter } from '../src/middleware/loginRateLimiter.js';
import { requireAuth } from '../src/middleware/requireAuth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import type { User } from '../src/generated/prisma/client.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { MemoryUserRepository } from './helpers/users.js';
import { createConnectionServices } from './helpers/connections.js';

const password = 'initial-password-123';
const changedPassword = 'replacement-password-456';

async function fixture(options: { production?: boolean; ipLimit?: number; emailIpLimit?: number; emailLimit?: number } = {}) {
  let time = Date.now();
  const hasher = new BcryptPasswordHasher(4);
  const user: User = { id: 'test-user', email: 'user@example.com', passwordHash: await hasher.hash(password),
    role: 'user', isActive: true, mustChangePassword: false, createdAt: new Date(), lastLoginAt: null };
  const users = new MemoryUserRepository([user]);
  const audit: Array<{ userId: string; action: string }> = [];
  const sessions = new SessionStore(() => time);
  const auditService = new AuditService({ async insert(userId, action) { audit.push({ userId, action }); } });
  const lifecycle = createConnectionServices(users, sessions, auditService, {now: () => time});
  const auth = new AuthService(users, hasher, auditService, sessions, lifecycle.connections);
  const userManagement = new UsersService(users, hasher, auditService, sessions, lifecycle.connections);
  const app = createApp({ users, auth, sessions, userManagement, ...lifecycle, production: options.production ?? false, cookieSecret: 's'.repeat(48),
    loginLimiter: createLoginRateLimiter({ ipLimit: options.ipLimit ?? 100, emailIpLimit: options.emailIpLimit ?? 100, emailLimit: options.emailLimit ?? 100, now: () => time }) });
  app.get('/protected', requireAuth(sessions, users), (_request, response) => response.json({ok: true}));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown = {}, cookie = '') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  const login = () => post('/auth/login', { email: user.email, password });
  return { user, users, hasher, auth, audit, sessions, post, login, base,
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
    assert.equal(result.user.mustChangePassword, false);
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
    f.user.mustChangePassword = true;
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

test('service enforces the 10-character boundary even when called without the controller', async () => {
  const f = await fixture();
  try {
    f.user.mustChangePassword = true;
    const session = f.sessions.create(f.user.id);
    const originalHash = f.user.passwordHash;
    for (const tooShort of ['123456789', '😀'.repeat(5)]) {
      await assert.rejects(f.auth.changePassword(f.user.id, password, tooShort), /at least 10 characters/);
    }
    await assert.rejects(f.auth.changePassword(f.user.id, password, 'é'.repeat(37)), /at most 72 UTF-8 bytes/);
    assert.equal(f.user.passwordHash, originalHash);
    assert.equal(f.user.mustChangePassword, true);
    assert.ok(f.sessions.get(session));
    await f.auth.changePassword(f.user.id, password, '1234567890');
    assert.equal(await f.hasher.verify('1234567890', f.user.passwordHash), true);
    assert.equal(f.user.mustChangePassword, false);
    assert.equal(f.sessions.get(session), undefined);
  } finally { await f.close(); }
});

test('temporary passwords are blocked from protected endpoints but can change password', async () => {
  const f = await fixture();
  try {
    f.user.mustChangePassword = true;
    const login = await f.login();
    assert.equal(login.status, 200);
    assert.equal((await login.json() as {user: {mustChangePassword: boolean}}).user.mustChangePassword, true);
    const sessionCookie = cookie(login);
    const blocked = await fetch(f.base + '/protected', {headers: {Cookie: sessionCookie}});
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), {message: 'password change required'});
    const short = await f.post('/auth/change-password', {currentPassword: password, newPassword: '123456789'}, sessionCookie);
    assert.equal(short.status, 400);
    const changed = await f.post('/auth/change-password', {currentPassword: password, newPassword: '1234567890'}, sessionCookie);
    assert.equal(changed.status, 200);
    assert.equal(f.user.mustChangePassword, false);
    assert.equal((await fetch(f.base + '/protected', {headers: {Cookie: sessionCookie}})).status, 401);
    const newLogin = await f.post('/auth/login', {email: f.user.email, password: '1234567890'});
    assert.equal(newLogin.status, 200);
    assert.equal((await fetch(f.base + '/protected', {headers: {Cookie: cookie(newLogin)}})).status, 200);
    assert.equal((await f.post('/auth/logout', {}, cookie(newLogin))).status, 200);
  } finally { await f.close(); }
});

test('users who must change their password can log out, clearing the cookie and deleting the session', async () => {
  const f = await fixture();
  try {
    f.user.mustChangePassword = true;
    const login = await f.login();
    const sessionCookie = cookie(login);
    const logout = await f.post('/auth/logout', {}, sessionCookie);
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), {message: 'logged out'});
    assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
    assert.equal((await f.post('/auth/change-password', {currentPassword: password, newPassword: changedPassword}, sessionCookie)).status, 401);
    assert.equal(f.user.mustChangePassword, true);
    assert.deepEqual(f.audit.map(entry => entry.action), ['login', 'logout']);
  } finally { await f.close(); }
});

for (const production of [false, true]) {
  test(`password-change response expires the session cookie (${production ? 'production' : 'development'})`, async () => {
    const f = await fixture({production});
    try {
      const login = await f.login();
      const changed = await f.post('/auth/change-password', {currentPassword: password, newPassword: changedPassword}, cookie(login));
      assert.equal(changed.status, 200);
      const cleared = changed.headers.get('set-cookie')!;
      assert.match(cleared, /^session=/);
      assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      assert.match(cleared, /Path=\//);
      assert.match(cleared, /HttpOnly/);
      assert.match(cleared, /SameSite=Strict/);
      if (production) assert.match(cleared, /; Secure/);
      else assert.doesNotMatch(cleared, /; Secure/);
      assert.equal((await f.post('/auth/logout', {}, cookie(login))).status, 401);
    } finally { await f.close(); }
  });
}

test('password_changed is audited once on success, without recording passwords or failed changes', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    const sessionCookie = cookie(login);
    for (const [currentPassword, newPassword] of [
      ['wrong', changedPassword], [password, 'short'], [password, password],
    ]) {
      assert.equal((await f.post('/auth/change-password', {currentPassword, newPassword}, sessionCookie)).status, 400);
    }
    assert.deepEqual(f.audit.map(entry => entry.action), ['login']);
    assert.equal((await f.post('/auth/change-password', {currentPassword: password, newPassword: changedPassword}, sessionCookie)).status, 200);
    assert.deepEqual(f.audit, [{userId: f.user.id, action: 'login'}, {userId: f.user.id, action: 'password_changed'}]);
    assert.ok(!JSON.stringify(f.audit).includes(password));
    assert.ok(!JSON.stringify(f.audit).includes(changedPassword));
    assert.equal((await f.post('/auth/change-password', {currentPassword: changedPassword, newPassword: password}, sessionCookie)).status, 401);
    assert.equal(f.audit.filter(entry => entry.action === 'password_changed').length, 1);
  } finally { await f.close(); }
});

test('password-change gate reloads the flag for existing sessions on every protected request', async () => {
  const f = await fixture();
  try {
    const login = await f.login();
    const headers = {Cookie: cookie(login)};
    assert.equal((await fetch(f.base + '/protected', {headers})).status, 200);
    f.user.mustChangePassword = true;
    assert.equal((await fetch(f.base + '/protected', {headers})).status, 403);
    f.user.isActive = false;
    assert.equal((await f.post('/auth/change-password', {currentPassword: password, newPassword: changedPassword}, cookie(login))).status, 401);
  } finally { await f.close(); }
});

test('rate limiter reads parsed JSON, limits normalized email plus IP, and resets after its window', async () => {
  const f = await fixture({emailIpLimit: 2});
  try {
    for (const email of ['user@example.com', ' USER@EXAMPLE.COM ']) {
      assert.equal((await f.post('/auth/login', {email, password: 'wrong'})).status, 401);
    }
    const limited = await f.login();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '900');
    assert.deepEqual(await limited.json(), {message: 'too many attempts; try again in 15 minutes'});
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

test('internal login errors are logged without credentials and do not consume the failure limit', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const f = await fixture({ipLimit: 1, emailIpLimit: 1, emailLimit: 1});
  try {
    const original = f.users.findByEmail;
    f.users.findByEmail = async () => {
      const error = new Error(`Database failed with password=${password}`);
      Object.assign(error, { code: 'ECONNREFUSED', cause: {password}, password });
      throw error;
    };
    for (let i = 0; i < 2; i++) {
      const response = await f.login();
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {message: 'wrong email or password'});
    }
    assert.equal(logger.mock.callCount(), 2);
    const logs = JSON.stringify(logger.mock.calls.map(call => call.arguments));
    assert.match(logs, /Internal request error/);
    assert.match(logs, /ECONNREFUSED/);
    assert.doesNotMatch(logs, /initial-password-123|Database failed|password|cookie|session/i);
    f.users.findByEmail = original;
    assert.equal((await f.login()).status, 200);
  } finally { await f.close(); }
});
