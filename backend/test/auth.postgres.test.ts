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
      const password = 'Temporary-test-password-123';
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
      const auth = new AuthService(users, new BcryptPasswordHasher(4), new AuditService(new PrismaAuditRepository(db)), sessions);
      server = createApp({users, sessions, auth, cookieSecret: 's'.repeat(48), production: false}).listen(0, '127.0.0.1');
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
      const logs = await db.auditLog.findMany({where: {userId: stored.id}, orderBy: {id: 'asc'}});
      assert.deepEqual(logs.map(log => log.action), ['login', 'logout']);
      assert.ok(logs.every(log => log.platform === null));
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
      await db.user.update({where: {id: stored.id}, data: {isActive: false}});
      assert.equal((await post('logout', {}, third.headers.get('set-cookie')!.split(';')[0])).status, 401);
      const disabled = await post('login', {email: stored.email, password: replacement});
      assert.equal(disabled.status, 401);
      assert.deepEqual(await disabled.json(), {message: 'wrong email or password'});
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await db?.$disconnect();
      // Only the database created by this test can be dropped here.
      if (created) await maintenance.query(`DROP DATABASE "${name}"`);
      await maintenance.end();
    }
  });
