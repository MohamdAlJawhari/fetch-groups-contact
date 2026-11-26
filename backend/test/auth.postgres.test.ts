import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaUserRepository } from '../src/modules/users/users.repository.js';
import { PrismaAuditRepository } from '../src/modules/audit/audit.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { BcryptPasswordHasher } from '../src/modules/auth/password.hasher.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { SessionStore } from '../src/modules/auth/session.store.js';
import { createApp } from '../src/app.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { createConnectionServices } from './helpers/connections.js';

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => resolve({code, output}));
  });
}

test('PostgreSQL: first-admin CLI, real repositories, password change, audit rows and disabled accounts',
  {skip: process.env.RUN_DATABASE_TESTS !== '1', timeout: 60_000}, async () => {
    assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
    const name = 'contact_export_auth_test_' + randomUUID().replaceAll('-', '');
    const url = new URL(process.env.DATABASE_URL);
    const maintenanceUrl = new URL(url);
    maintenanceUrl.pathname = '/postgres';
    const maintenance = new pg.Client({connectionString: maintenanceUrl.toString(), connectionTimeoutMillis: 5000});
    await maintenance.connect();
    let created = false;
    let db: PrismaClient | undefined;
    let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
    try {
      await maintenance.query(`CREATE DATABASE "${name}"`);
      created = true;
      url.pathname = '/' + name;
      let password = 'Temporary-test-password-123';
      const env = {...process.env, DATABASE_URL: url.toString(), ADMIN_PASSWORD: password};
      const migration = await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
      assert.equal(migration.code, 0, 'Test database migration failed');
      const admin = await run(['--import', 'tsx', 'src/scripts/create-admin.ts', '--email', ' ADMIN@EXAMPLE.COM '], env);
      assert.equal(admin.code, 0, admin.output);
      assert.ok(!admin.output.includes(password));
      const duplicate = await run(['--import', 'tsx', 'src/scripts/create-admin.ts', '--email', 'other@example.com'], env);
      assert.notEqual(duplicate.code, 0);
      assert.match(duplicate.output, /admin already exists/);
      db = new PrismaClient({adapter: new PrismaPg({connectionString: url.toString()})});
      const stored = await db.user.findUniqueOrThrow({where: {email: 'admin@example.com'}});
      assert.equal(stored.role, 'admin');
      assert.equal(stored.mustChangePassword, true);
      assert.notEqual(stored.passwordHash, password);
      assert.match(stored.passwordHash, /^\$2[aby]\$12\$/);
      assert.equal(await db.user.count(), 1);
      const users = new PrismaUserRepository(db);
      const sessions = new SessionStore();
      const hasher = new BcryptPasswordHasher(4);
      const auditService = new AuditService(new PrismaAuditRepository(db));
      const lifecycle = createConnectionServices(users, sessions, auditService);
      const auth = new AuthService(users, hasher, auditService, sessions, lifecycle.connections);
      const userManagement = new UsersService(users, hasher, auditService, sessions, lifecycle.connections);
      server = createApp({users, sessions, auth, userManagement, ...lifecycle, cookieSecret: 's'.repeat(48), production: false}).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const post = (path: string, body: unknown, cookie = '') => fetch(`http://127.0.0.1:${address.port}/auth/${path}`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Cookie: cookie}, body: JSON.stringify(body),
      });
      const login = await post('login', {email: stored.email, password});
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await post('logout', {}, cookie)).status, 200);
      assert.equal((await post('logout', {}, cookie)).status, 401);
      const temporaryLogin = await post('login', {email: stored.email, password});
      assert.equal(temporaryLogin.status, 200);
      const initialReplacement = '1234567890';
      const changed = await post('change-password', {currentPassword: password, newPassword: initialReplacement}, temporaryLogin.headers.get('set-cookie')!.split(';')[0]);
      assert.equal(changed.status, 200);
      assert.match(changed.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
      password = initialReplacement;
      const ready = await post('login', {email: stored.email, password});
      assert.equal(ready.status, 200);
      assert.equal((await post('logout', {}, ready.headers.get('set-cookie')!.split(';')[0])).status, 200);
      const logs = await db.auditLog.findMany({where: {userId: stored.id}, orderBy: {id: 'asc'}});
      assert.deepEqual(logs.map(log => log.action), ['login', 'logout', 'login', 'password_changed', 'login', 'logout']);
      assert.ok(logs.every(log => log.platform === null));
      assert.ok(logs.every(log => log.targetUserId === null));
      const loggedIn = await db.user.findUniqueOrThrow({where: {id: stored.id}});
      assert.ok(loggedIn.lastLoginAt);
      const second = await post('login', {email: stored.email, password});
      const secondCookie = second.headers.get('set-cookie')!.split(';')[0];
      const replacement = 'New-test-password-456';
      assert.equal((await post('change-password', {currentPassword: password, newPassword: replacement}, secondCookie)).status, 200);
      assert.equal((await db.user.findUniqueOrThrow({where: {id: stored.id}})).mustChangePassword, false);
      assert.equal((await post('logout', {}, secondCookie)).status, 401);
      assert.equal((await post('login', {email: stored.email, password})).status, 401);
      const third = await post('login', {email: stored.email, password: replacement});
      assert.equal(third.status, 200);
      const adminCookie = third.headers.get('set-cookie')!.split(';')[0];
      const adminRequest = (method: string, path: string, body?: unknown, cookie = adminCookie) =>
        fetch(`http://127.0.0.1:${address.port}/admin/users${path}`, {
          method, headers: {'Content-Type': 'application/json', Cookie: cookie},
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const createdUserResponse = await adminRequest('POST', '', {email: ' NEW@EXAMPLE.COM '});
      assert.equal(createdUserResponse.status, 201);
      const createdBody = await createdUserResponse.json() as {user: {id: string}; temporaryPassword: string};
      assert.equal(JSON.stringify(createdBody).includes('passwordHash'), false);
      const target = await db.user.findUniqueOrThrow({where: {id: createdBody.user.id}});
      assert.equal(target.email, 'new@example.com');
      assert.equal(target.role, 'user');
      assert.equal(target.mustChangePassword, true);
      assert.equal(await hasher.verify(createdBody.temporaryPassword, target.passwordHash), true);
      const duplicateEmail = await adminRequest('POST', '', {email: 'NEW@EXAMPLE.COM'});
      assert.equal(duplicateEmail.status, 409);
      const racing = await Promise.all([
        adminRequest('POST', '', {email: 'race@example.com'}),
        adminRequest('POST', '', {email: ' RACE@EXAMPLE.COM '}),
      ]);
      assert.deepEqual(racing.map(response => response.status).sort(), [201, 409]);
      assert.equal(await db.user.count({where: {email: 'race@example.com'}}), 1);
      const racedUser = await db.user.findUniqueOrThrow({where: {email: 'race@example.com'}});
      let userLogin = await post('login', {email: ` ${target.email.toUpperCase()} `, password: createdBody.temporaryPassword});
      assert.equal(userLogin.status, 200);
      let userCookie = userLogin.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await post('change-password', {currentPassword: createdBody.temporaryPassword, newPassword: 'User-test-password-123'}, userCookie)).status, 200);
      userLogin = await post('login', {email: target.email, password: 'User-test-password-123'});
      userCookie = userLogin.headers.get('set-cookie')!.split(';')[0];
      for (const [method, path] of [
        ['GET', ''], ['POST', ''], ['POST', `/${target.id}/reset-password`],
        ['POST', `/${target.id}/enable`], ['POST', `/${target.id}/disable`],
      ]) assert.equal((await adminRequest(method, path, method === 'POST' ? {email: 'blocked@example.com'} : undefined, userCookie)).status, 403);
      const connectionResponse = await fetch(`http://127.0.0.1:${address.port}/connections`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Cookie: userCookie}, body: JSON.stringify({platform: 'telegram'}),
      });
      assert.equal(connectionResponse.status, 201);
      const connectionId = (await connectionResponse.json() as {id: string}).id;
      const reset = await adminRequest('POST', `/${target.id}/reset-password`);
      assert.equal(reset.status, 200);
      const resetBody = await reset.json() as {temporaryPassword: string};
      const resetTarget = await db.user.findUniqueOrThrow({where: {id: target.id}});
      assert.equal(resetTarget.mustChangePassword, true);
      assert.equal(await hasher.verify(resetBody.temporaryPassword, resetTarget.passwordHash), true);
      assert.equal((await post('logout', {}, userCookie)).status, 401);
      assert.equal(lifecycle.connectionRegistry.get(connectionId), undefined);
      const connectionEvents = await db.auditLog.findMany({where: {userId: target.id, action: {startsWith: 'connection_'}}, orderBy: {id: 'asc'}});
      assert.deepEqual(connectionEvents.map(event => [event.action, event.platform, event.targetUserId]), [
        ['connection_started', 'telegram', null], ['connection_ended', 'telegram', null],
      ]);
      userLogin = await post('login', {email: target.email, password: resetBody.temporaryPassword});
      userCookie = userLogin.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await adminRequest('POST', `/${target.id}/disable`)).status, 200);
      assert.equal((await db.user.findUniqueOrThrow({where: {id: target.id}})).isActive, false);
      assert.equal((await post('logout', {}, userCookie)).status, 401);
      assert.equal((await adminRequest('POST', `/${target.id}/enable`)).status, 200);
      assert.equal((await db.user.findUniqueOrThrow({where: {id: target.id}})).isActive, true);
      const list = await adminRequest('GET', '');
      assert.equal(list.status, 200);
      const listText = await list.text();
      assert.doesNotMatch(listText, /passwordHash|password_hash|temporaryPassword|\$2[aby]\$/);
      assert.equal(listText.includes(resetBody.temporaryPassword), false);
      assert.equal((await adminRequest('POST', `/${stored.id}/disable`)).status, 400);
      const adminEvents = await db.auditLog.findMany({where: {userId: stored.id, action: {startsWith: 'admin_'}}, orderBy: {id: 'asc'}});
      assert.deepEqual(adminEvents.map(event => event.action), [
        'admin_user_created', 'admin_user_created', 'admin_password_reset',
        'admin_user_disabled', 'admin_user_enabled',
      ]);
      assert.ok(adminEvents.every(event => event.platform === null));
      assert.deepEqual(adminEvents.map(event => event.targetUserId), [
        target.id, racedUser.id, target.id, target.id, target.id,
      ]);
      // T52: deleting keeps the row and its audit rows, frees the email, and the CHECK constraint holds.
      const targetEmail = target.email;
      const auditBefore = await db.auditLog.count({where: {OR: [{userId: target.id}, {targetUserId: target.id}]}});
      assert.equal((await adminRequest('DELETE', `/${target.id}`)).status, 204);
      const removed = await db.user.findUniqueOrThrow({where: {id: target.id}});
      assert.equal(removed.isActive, false);
      assert.ok(removed.deletedAt);
      assert.equal(removed.deletedEmail, targetEmail);
      assert.equal(removed.email, `deleted-${target.id}@deleted.invalid`);
      assert.equal(await db.auditLog.count({where: {OR: [{userId: target.id}, {targetUserId: target.id}]}}), auditBefore + 1);
      assert.equal((await adminRequest('DELETE', `/${target.id}`)).status, 404);
      assert.equal((await adminRequest('POST', `/${target.id}/enable`)).status, 404);
      await assert.rejects(db.user.update({where: {id: target.id}, data: {isActive: true}}), 'the CHECK keeps deleted accounts inactive');
      assert.equal((await post('login', {email: targetEmail, password: resetBody.temporaryPassword})).status, 401);
      assert.equal(((await (await adminRequest('GET', '')).json()) as {users: Array<{id: string}>}).users.some(user => user.id === target.id), false);
      assert.equal((await adminRequest('POST', '', {email: targetEmail})).status, 201);
      await db.user.update({where: {id: stored.id}, data: {isActive: false}});
      assert.equal((await post('logout', {}, third.headers.get('set-cookie')!.split(';')[0])).status, 401);
      const disabled = await post('login', {email: stored.email, password: replacement});
      assert.equal(disabled.status, 403);
      assert.deepEqual(await disabled.json(), {message: 'this account is disabled. Please contact your admin'});
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await db?.$disconnect();
      // Only the database created by this test can be dropped here.
      if (created) await maintenance.query(`DROP DATABASE "${name}"`);
      await maintenance.end();
    }
  });
