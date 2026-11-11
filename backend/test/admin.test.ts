import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { BcryptPasswordHasher } from '../src/modules/auth/password.hasher.js';
import { SessionStore } from '../src/modules/auth/session.store.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { User } from '../src/generated/prisma/client.js';
import { MemoryUserRepository } from './helpers/users.js';

const initialPassword = 'Initial-user-password-123';

async function fixture() {
  const hasher = new BcryptPasswordHasher(4);
  const passwordHash = await hasher.hash(initialPassword);
  const makeUser = (role: string): User => ({id: randomUUID(), email: `${role}@example.com`, role,
    passwordHash, isActive: true, mustChangePassword: false, createdAt: new Date(), lastLoginAt: null});
  const admin = makeUser('admin');
  const member = makeUser('user');
  const users = new MemoryUserRepository([admin, member]);
  const sessions = new SessionStore();
  const records: Array<{userId: string; action: string; platform?: string; targetUserId?: string}> = [];
  const audit = new AuditService({async insert(userId, action, platform, targetUserId) { records.push({userId, action, platform, targetUserId}); }});
  const userManagement = new UsersService(users, hasher, audit, sessions);
  const auth = new AuthService(users, hasher, audit, sessions);
  const server = createApp({users, sessions, auth, userManagement, cookieSecret: 's'.repeat(48), production: false}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (method: string, path: string, body?: unknown, cookie = '') => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: {'Content-Type': 'application/json', Cookie: cookie},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (user: Pick<User, 'email'>, password = initialPassword) => {
    const response = await request('POST', '/auth/login', {email: user.email, password});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return {admin, member, users, sessions, records, hasher, userManagement, request, login,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function routes(id: string): Array<[string, string, unknown?]> {
  return [
    ['GET', '/admin/users'], ['POST', '/admin/users', {email: 'new@example.com'}],
    ['POST', `/admin/users/${id}/reset-password`], ['POST', `/admin/users/${id}/enable`],
    ['POST', `/admin/users/${id}/disable`],
  ];
}

function assertNoHash(value: unknown) { assert.doesNotMatch(JSON.stringify(value), /passwordHash|password_hash|\$2[aby]\$/); }

test('a normal user is rejected on every admin route without side effects', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.member);
    for (const [method, path, body] of routes(f.admin.id)) {
      const response = await f.request(method, path, body, cookie);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), {message: 'admin access required'});
    }
    assert.equal(f.users.records.size, 2);
    assert.equal(f.admin.isActive, true);
    assert.deepEqual(f.records.map(record => record.action), ['login']);
  } finally { await f.close(); }
});

test('every admin route requires a session and rejects temporary-password and disabled admins', async () => {
  const f = await fixture();
  try {
    for (const [method, path, body] of routes(f.member.id)) {
      assert.equal((await f.request(method, path, body)).status, 401, path);
    }
    const cookie = await f.login(f.admin);
    f.admin.mustChangePassword = true;
    for (const [method, path, body] of routes(f.member.id)) {
      assert.equal((await f.request(method, path, body, cookie)).status, 403, path);
    }
    f.admin.mustChangePassword = false;
    f.admin.isActive = false;
    for (const [method, path, body] of routes(f.member.id)) {
      assert.equal((await f.request(method, path, body, cookie)).status, 401, path);
    }
  } finally { await f.close(); }
});

test('admin creates a normalized user with a random temporary password and lists only safe fields', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    const created = await f.request('POST', '/admin/users', {email: ' NEW@EXAMPLE.COM '}, cookie);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const result = await created.json() as {user: User; temporaryPassword: string};
    assertNoHash(result);
    assert.equal(result.user.email, 'new@example.com');
    assert.equal(result.user.role, 'user');
    assert.equal(result.user.isActive, true);
    assert.equal(result.user.mustChangePassword, true);
    assert.match(result.temporaryPassword, /^[A-Za-z0-9_-]{32}$/);
    const stored = (await f.users.findById(result.user.id))!;
    assert.notEqual(stored.passwordHash, result.temporaryPassword);
    assert.equal(await f.hasher.verify(result.temporaryPassword, stored.passwordHash), true);
    assert.equal(JSON.stringify(stored).includes(result.temporaryPassword), false);
    const second = await f.request('POST', '/admin/users', {email: 'second@example.com'}, cookie);
    const secondResult = await second.json() as {temporaryPassword: string};
    assert.notEqual(secondResult.temporaryPassword, result.temporaryPassword);
    const listed = await f.request('GET', '/admin/users', undefined, cookie);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const list = await listed.json() as {users: User[]};
    assert.equal(list.users.length, 4);
    assertNoHash(list);
    assert.equal(JSON.stringify(list).includes(result.temporaryPassword), false);
    assert.equal(JSON.stringify(list).includes('temporaryPassword'), false);
    const newCookie = await f.login(stored, result.temporaryPassword);
    assert.equal((await f.request('GET', '/admin/users', undefined, newCookie)).status, 403);
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_user_created' && record.targetUserId === result.user.id));
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_users_listed' && record.targetUserId === undefined));
    assert.equal(JSON.stringify(f.records).includes(result.temporaryPassword), false);
  } finally { await f.close(); }
});

test('duplicate emails and attempts to choose a role or password are rejected', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    const duplicate = await f.request('POST', '/admin/users', {email: ' USER@EXAMPLE.COM '}, cookie);
    assert.equal(duplicate.status, 409);
    assertNoHash(await duplicate.json());
    for (const body of [{email: 'invalid'}, {}, {email: 'new@example.com', role: 'admin'}, {email: 'new@example.com', password: initialPassword}]) {
      assert.equal((await f.request('POST', '/admin/users', body, cookie)).status, 400);
    }
    assert.equal(f.users.records.size, 2);
    assert.deepEqual(f.records.map(record => record.action), ['login']);
  } finally { await f.close(); }
});

test('reset replaces the hash, sets the password-change flag, and revokes every target session only', async () => {
  const f = await fixture();
  try {
    const adminCookie = await f.login(f.admin);
    const first = await f.login(f.member);
    const second = await f.login(f.member);
    const otherSession = f.sessions.create(f.admin.id);
    const response = await f.request('POST', `/admin/users/${f.member.id}/reset-password`, {}, adminCookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json() as {user: User; temporaryPassword: string};
    assertNoHash(result);
    assert.equal(result.user.mustChangePassword, true);
    assert.match(result.temporaryPassword, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(await f.hasher.verify(result.temporaryPassword, f.member.passwordHash), true);
    assert.equal(await f.hasher.verify(initialPassword, f.member.passwordHash), false);
    for (const cookie of [first, second]) assert.equal((await f.request('POST', '/auth/logout', {}, cookie)).status, 401);
    assert.ok(f.sessions.get(otherSession));
    assert.equal((await f.request('GET', '/admin/users', undefined, adminCookie)).status, 200);
    assert.equal((await f.request('POST', '/auth/login', {email: f.member.email, password: initialPassword})).status, 401);
    await f.login(f.member, result.temporaryPassword);
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_password_reset' && record.targetUserId === f.member.id));
    assert.equal(JSON.stringify(f.records).includes(result.temporaryPassword), false);
  } finally { await f.close(); }
});

test('disable revokes all sessions, enable permits new login without restoring revoked sessions', async () => {
  const f = await fixture();
  try {
    const adminCookie = await f.login(f.admin);
    const first = await f.login(f.member);
    const second = await f.login(f.member);
    const disabled = await f.request('POST', `/admin/users/${f.member.id}/disable`, {}, adminCookie);
    assert.equal(disabled.status, 200);
    const disabledResult = await disabled.json() as {user: User};
    assertNoHash(disabledResult);
    assert.equal(disabledResult.user.isActive, false);
    for (const cookie of [first, second]) assert.equal((await f.request('POST', '/auth/logout', {}, cookie)).status, 401);
    assert.equal((await f.request('POST', '/auth/login', {email: f.member.email, password: initialPassword})).status, 401);
    const enabled = await f.request('POST', `/admin/users/${f.member.id}/enable`, {}, adminCookie);
    assert.equal(enabled.status, 200);
    const enabledResult = await enabled.json() as {user: User};
    assertNoHash(enabledResult);
    assert.equal(enabledResult.user.isActive, true);
    assert.equal((await f.request('POST', '/auth/logout', {}, first)).status, 401);
    await f.login(f.member);
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_user_disabled' && record.targetUserId === f.member.id));
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_user_enabled' && record.targetUserId === f.member.id));
  } finally { await f.close(); }
});

test('admin cannot disable their own account and remains logged in', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    const response = await f.request('POST', `/admin/users/${f.admin.id}/disable`, {}, cookie);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {message: 'you cannot disable your own account'});
    assert.equal(f.admin.isActive, true);
    assert.equal((await f.request('GET', '/admin/users', undefined, cookie)).status, 200);
    assert.equal(f.records.filter(record => record.action === 'admin_user_disabled').length, 0);
  } finally { await f.close(); }
});

test('invalid UUIDs and nonexistent users are rejected without audit or secret responses', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    for (const action of ['reset-password', 'enable', 'disable']) {
      assert.equal((await f.request('POST', `/admin/users/invalid/${action}`, {}, cookie)).status, 400);
      const missing = await f.request('POST', `/admin/users/${randomUUID()}/${action}`, {}, cookie);
      assert.equal(missing.status, 404);
      assertNoHash(await missing.json());
    }
    assert.deepEqual(f.records.map(record => record.action), ['login']);
  } finally { await f.close(); }
});

test('demoting an admin takes effect on the next request using the existing session', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    f.admin.role = 'user';
    assert.equal((await f.request('GET', '/admin/users', undefined, cookie)).status, 403);
  } finally { await f.close(); }
});

test('admin can reset their own password, which invalidates their sessions and restores the change-password gate', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    const extra = f.sessions.create(f.admin.id);
    const response = await f.request('POST', `/admin/users/${f.admin.id}/reset-password`, {}, cookie);
    assert.equal(response.status, 200);
    const result = await response.json() as {temporaryPassword: string};
    assert.equal(f.sessions.get(extra), undefined);
    assert.equal((await f.request('GET', '/admin/users', undefined, cookie)).status, 401);
    const temporaryCookie = await f.login(f.admin, result.temporaryPassword);
    assert.equal((await f.request('GET', '/admin/users', undefined, temporaryCookie)).status, 403);
    assert.equal((await f.request('POST', '/auth/logout', {}, temporaryCookie)).status, 200);
    assert.ok(f.records.some(record => record.userId === f.admin.id && record.action === 'admin_password_reset' && record.targetUserId === f.admin.id));
  } finally { await f.close(); }
});

test('temporary passwords and hashes never appear in server logs or internal-error responses', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const f = await fixture();
  try {
    const cookie = await f.login(f.admin);
    const created = await f.request('POST', '/admin/users', {email: 'log-test@example.com'}, cookie);
    const createdResult = await created.json() as {user: User; temporaryPassword: string};
    const reset = await f.request('POST', `/admin/users/${createdResult.user.id}/reset-password`, {}, cookie);
    const resetResult = await reset.json() as {temporaryPassword: string};
    let generatedOnFailure = '';
    let failedHash = '';
    const realHash = f.hasher.hash.bind(f.hasher);
    t.mock.method(f.hasher, 'hash', async (password: string) => {
      generatedOnFailure = password;
      failedHash = await realHash(password);
      return failedHash;
    });
    f.users.create = async () => { throw new Error(`Failed to save ${generatedOnFailure} ${failedHash}`); };
    const failed = await f.request('POST', '/admin/users', {email: 'failure@example.com'}, cookie);
    assert.equal(failed.status, 500);
    const failureBody = await failed.text();
    const logs = JSON.stringify([log, warn, error].flatMap(mock => mock.mock.calls.map(call => call.arguments)));
    assert.equal(error.mock.callCount(), 1);
    for (const secret of [createdResult.temporaryPassword, resetResult.temporaryPassword, generatedOnFailure, failedHash]) {
      assert.ok(secret.length > 0);
      assert.equal(logs.includes(secret), false);
      assert.equal(failureBody.includes(secret), false);
    }
    assertNoHash(JSON.parse(failureBody));
  } finally { await f.close(); }
});
