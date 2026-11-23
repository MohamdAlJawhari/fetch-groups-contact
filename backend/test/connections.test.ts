import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { BcryptPasswordHasher } from '../src/modules/auth/password.hasher.js';
import { SessionStore } from '../src/modules/auth/session.store.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ConnectionRegistry } from '../src/modules/connections/connection.registry.js';
import { ConnectionsService } from '../src/modules/connections/connections.service.js';
import { ConnectionReaper } from '../src/modules/connections/connection.reaper.js';
import { FakePlatform } from '../src/platforms/fake.platform.js';
import { createPlatform } from '../src/platforms/platform.factory.js';
import { PlatformError } from '../src/platforms/platform.errors.js';
import type { PlatformFactory, PlatformName } from '../src/platforms/platform.types.js';
import type { User } from '../src/generated/prisma/client.js';
import { ExcelWriter } from '../src/export/excel.writer.js';
import { ExportService } from '../src/export/export.service.js';
import { MemoryUserRepository } from './helpers/users.js';

const password = 'Connection-test-password-123';
async function fixture(factory?: (now: () => number) => PlatformFactory, exporter = new ExportService()) {
  let time = 0;
  const now = () => time;
  const hasher = new BcryptPasswordHasher(4);
  const passwordHash = await hasher.hash(password);
  const user = (name: string): User => ({id: randomUUID(), email: `${name}@example.com`, passwordHash,
    role: name === 'admin' ? 'admin' : 'user', isActive: true, mustChangePassword: false,
    createdAt: new Date(), lastLoginAt: null});
  const a = user('a'); const b = user('b'); const admin = user('admin');
  const users = new MemoryUserRepository([a, b, admin]);
  const sessions = new SessionStore(now);
  const events: Array<{userId: string; action: string; platform?: string; targetUserId?: string}> = [];
  const audit = new AuditService({async insert(userId, action, platform, targetUserId) { events.push({userId, action, platform, targetUserId}); }});
  const connectionRegistry = new ConnectionRegistry(now);
  const connections = new ConnectionsService(connectionRegistry, factory?.(now) ?? (name => createPlatform(name, {now})), audit, users, sessions, exporter, now);
  const auth = new AuthService(users, hasher, audit, sessions, connections);
  const userManagement = new UsersService(users, hasher, audit, sessions, connections);
  const reaper = new ConnectionReaper(connectionRegistry, connections, 600_000, now);
  const server = createApp({users, sessions, auth, userManagement, connections, connectionRegistry,
    cookieSecret: 's'.repeat(48), production: false}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (method: string, path: string, cookie = '', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: {'Content-Type': 'application/json', Cookie: cookie}, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (user: User) => {
    const response = await request('POST', '/auth/login', '', {email: user.email, password});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const start = async (cookie: string, platform: PlatformName = 'telegram') => {
    const response = await request('POST', '/connections', cookie, {platform});
    assert.equal(response.status, 201);
    return await response.json() as {id: string; platform: PlatformName; status: string; qr?: string};
  };
  return {a, b, admin, users, time: () => time, origin: `http://127.0.0.1:${address.port}`, sessions, auth, connections, connectionRegistry, events, reaper, request, login, start,
    advance(ms: number) { time += ms; },
    async close() {
      await reaper.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await connections.shutdown();
    },
  };
}

test('fake platforms provide placeholder QR, scan transition, groups, and contact categories for both platforms', async () => {
  let time = 0;
  for (const name of ['telegram', 'whatsapp'] as const) {
    const platform = createPlatform(name, {now: () => time});
    assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
    await platform.connect();
    assert.deepEqual(await platform.getStatus(), {status: 'waiting-for-scan', qr: `FAKE_QR:${name}:scan-placeholder`});
    await assert.rejects(platform.listGroups(), /not connected/);
    time += 3_000;
    assert.deepEqual(await platform.getStatus(), {status: 'connected'});
    assert.equal((await platform.listGroups()).length, 2);
    const categories = await platform.listContacts(['sample-group-1']);
    assert.deepEqual(categories.map(item => item.category), name === 'telegram'
      ? ['saved', 'unsaved_reachable', 'unsaved_unreachable'] : ['saved', 'unsaved']);
    assert.ok(categories.every(item => item.contacts.length > 0));
    await platform.disconnect();
    assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
  }
});

test('connection endpoints return waiting QR, connected status and groups, then delete cleanly', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.a);
    const started = await f.start(cookie);
    assert.match(started.id, /^[a-f0-9]{64}$/);
    assert.equal(started.status, 'waiting-for-scan');
    assert.ok(started.qr);
    assert.equal((await f.request('GET', `/connections/${started.id}/groups`, cookie)).status, 409);
    f.advance(3_000);
    const status = await f.request('GET', `/connections/${started.id}`, cookie);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), {id: started.id, platform: 'telegram', status: 'connected'});
    const groups = await f.request('GET', `/connections/${started.id}/groups`, cookie);
    assert.equal(groups.status, 200);
    assert.equal((await groups.json() as {groups: unknown[]}).groups.length, 2);
    assert.equal((await f.request('DELETE', `/connections/${started.id}`, cookie)).status, 204);
    assert.equal(f.connectionRegistry.get(started.id), undefined);
    assert.equal((await f.request('GET', `/connections/${started.id}`, cookie)).status, 404);
    const events = f.events.filter(event => event.action.startsWith('connection_'));
    assert.deepEqual(events, [
      {userId: f.a.id, action: 'connection_started', platform: 'telegram', targetUserId: undefined},
      {userId: f.a.id, action: 'connection_ended', platform: 'telegram', targetUserId: undefined},
    ]);
    assert.equal(JSON.stringify(events).includes(started.qr!), false);
    assert.doesNotMatch(JSON.stringify(events), /contact|phone|username|qr/i);
  } finally { await f.close(); }
});

test('user B gets identical 404 responses for user A connections and missing IDs on every owned route', async () => {
  const f = await fixture();
  try {
    const cookieA = await f.login(f.a); const cookieB = await f.login(f.b);
    const started = await f.start(cookieA);
    f.advance(5_000);
    for (const [method, suffix] of [['GET', ''], ['GET', '/groups'], ['DELETE', '']]) {
      for (const id of [started.id, 'missing']) {
        const response = await f.request(method, `/connections/${id}${suffix}`, cookieB);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {message: 'connection not found'});
      }
    }
    assert.equal(f.connectionRegistry.get(started.id)!.lastActivity, 0);
    assert.equal((await f.request('GET', `/connections/${started.id}`, cookieA)).status, 200);
    assert.equal(f.connectionRegistry.get(started.id)!.lastActivity, 5_000);
  } finally { await f.close(); }
});

test('starting another connection disconnects and replaces the existing one', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(f.a);
    const first = await f.start(cookie);
    const oldPlatform = f.connectionRegistry.get(first.id)!.platform;
    const second = await f.start(cookie, 'whatsapp');
    assert.notEqual(first.id, second.id);
    assert.deepEqual(await oldPlatform.getStatus(), {status: 'disconnected'});
    assert.equal(f.connectionRegistry.get(first.id), undefined);
    assert.equal(f.connectionRegistry.entries().length, 1);
    assert.deepEqual(f.events.filter(event => event.action.startsWith('connection_')).map(event => [event.action, event.platform]), [
      ['connection_started', 'telegram'], ['connection_ended', 'telegram'], ['connection_started', 'whatsapp'],
    ]);
  } finally { await f.close(); }
});

test('concurrent starts are serialized and never leave multiple live platforms for one user', async () => {
  let active = 0; let peak = 0;
  const f = await fixture(now => name => {
    class TrackedPlatform extends FakePlatform {
      override async connect() { await Promise.resolve(); active++; peak = Math.max(peak, active); await super.connect(); }
      override async disconnect() { active--; await super.disconnect(); }
    }
    return new TrackedPlatform(name, {now});
  });
  try {
    const sessionId = f.sessions.create(f.a.id);
    const results = await Promise.all([
      f.connections.start(f.a.id, 'telegram', sessionId),
      f.connections.start(f.a.id, 'whatsapp', sessionId),
      f.connections.start(f.a.id, 'telegram', sessionId),
    ]);
    assert.equal(new Set(results.map(result => result.id)).size, 3);
    assert.equal(peak, 1);
    assert.equal(active, 1);
    assert.equal(f.connectionRegistry.entries().length, 1);
  } finally { await f.close(); }
  assert.equal(active, 0);
});

test('fake-clock reaper expires only idle connections; status and groups refresh activity', async () => {
  const f = await fixture();
  try {
    const cookieA = await f.login(f.a); const cookieB = await f.login(f.b);
    const a = await f.start(cookieA); const b = await f.start(cookieB, 'whatsapp');
    const oldA = f.connectionRegistry.get(a.id)!.platform;
    f.advance(600_000);
    await f.reaper.runOnce();
    assert.equal(f.connectionRegistry.entries().length, 2);
    assert.equal((await f.request('GET', `/connections/${b.id}`, cookieB)).status, 200);
    f.advance(1);
    await f.reaper.runOnce();
    assert.equal(f.connectionRegistry.get(a.id), undefined);
    assert.deepEqual(await oldA.getStatus(), {status: 'disconnected'});
    assert.ok(f.connectionRegistry.get(b.id));
    f.advance(500_000);
    assert.equal((await f.request('GET', `/connections/${b.id}/groups`, cookieB)).status, 200);
    f.advance(200_000);
    await f.reaper.runOnce();
    assert.ok(f.connectionRegistry.get(b.id));
    f.advance(400_001);
    await f.reaper.runOnce();
    assert.equal(f.connectionRegistry.entries().length, 0);
    assert.equal(f.events.filter(event => event.action === 'connection_ended').length, 2);
  } finally { await f.close(); }
});

test('logout destroys the user connection while preserving other users connections', async () => {
  const f = await fixture();
  try {
    const cookieA = await f.login(f.a); const cookieB = await f.login(f.b);
    const a = await f.start(cookieA); const b = await f.start(cookieB);
    const platform = f.connectionRegistry.get(a.id)!.platform;
    assert.equal((await f.request('POST', '/auth/logout', cookieA)).status, 200);
    assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
    assert.equal(f.connectionRegistry.get(a.id), undefined);
    assert.ok(f.connectionRegistry.get(b.id));
    assert.equal((await f.request('GET', `/connections/${a.id}`, cookieA)).status, 401);
    assert.deepEqual(f.events.filter(event => event.userId === f.a.id).slice(-2).map(event => event.action), ['connection_ended', 'logout']);
  } finally { await f.close(); }
});

for (const action of ['disable', 'reset-password'] as const) {
  test(`admin ${action} destroys the target connection and invalidates its session`, async () => {
    const f = await fixture();
    try {
      const cookie = await f.login(f.a); const adminCookie = await f.login(f.admin);
      const started = await f.start(cookie);
      const platform = f.connectionRegistry.get(started.id)!.platform;
      const response = await f.request('POST', `/admin/users/${f.a.id}/${action}`, adminCookie);
      assert.equal(response.status, 200);
      assert.equal(f.connectionRegistry.get(started.id), undefined);
      assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
      assert.equal((await f.request('GET', `/connections/${started.id}`, cookie)).status, 401);
      assert.equal(f.events.filter(event => event.action === 'connection_ended').length, 1);
    } finally { await f.close(); }
  });
}

test('connection routes reject missing auth, temporary passwords, and invalid platform input', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('POST', '/connections', '', {platform: 'telegram'})).status, 401);
    const cookie = await f.login(f.a);
    for (const body of [{platform: 'other'}, {}, {platform: 'telegram', ownerId: f.b.id}]) {
      assert.equal((await f.request('POST', '/connections', cookie, body)).status, 400);
    }
    f.a.mustChangePassword = true;
    assert.equal((await f.request('POST', '/connections', cookie, {platform: 'telegram'})).status, 403);
    assert.equal(f.connectionRegistry.entries().length, 0);
  } finally { await f.close(); }
});

test('reaper schedules every minute, avoids duplicate timers and clears its timer on stop', async (t) => {
  const f = await fixture();
  try {
    let callback: (() => void) | undefined;
    const handle = {unref() {}};
    const schedule = t.mock.method(globalThis, 'setInterval', (fn: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 60_000); callback = fn; return handle;
    });
    const clear = t.mock.method(globalThis, 'clearInterval', () => {});
    f.reaper.start(); f.reaper.start();
    assert.equal(schedule.mock.callCount(), 1);
    assert.ok(callback);
    callback();
    await f.reaper.stop();
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(clear.mock.calls[0].arguments[0], handle);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('shutdown disconnects live platforms and prevents new starts', async () => {
  const f = await fixture();
  try {
    const sessionId = f.sessions.create(f.a.id);
    const started = await f.connections.start(f.a.id, 'telegram', sessionId);
    const platform = f.connectionRegistry.get(started.id)!.platform;
    await f.connections.shutdown();
    assert.equal(f.connectionRegistry.entries().length, 0);
    assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
    await assert.rejects(f.connections.start(f.a.id, 'whatsapp', sessionId), /shutting down/);
  } finally { await f.close(); }
});

test('logout during an asynchronous connect cannot leave an orphan connection', async () => {
  let entered!: () => void; let release!: () => void;
  const connecting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let platform!: FakePlatform;
  const f = await fixture(now => name => {
    class SlowPlatform extends FakePlatform {
      override async connect() { await super.connect(); entered(); await blocked; }
    }
    platform = new SlowPlatform(name, {now});
    return platform;
  });
  try {
    const sessionId = f.sessions.create(f.a.id);
    const start = f.connections.start(f.a.id, 'telegram', sessionId);
    const rejected = assert.rejects(start, /authentication required/);
    await connecting;
    const logout = f.auth.logout(sessionId, f.a.id);
    release();
    await rejected; await logout;
    assert.equal(f.connectionRegistry.entries().length, 0);
    assert.deepEqual(await platform.getStatus(), {status: 'disconnected'});
    assert.equal(f.events.filter(event => event.action === 'connection_started').length, 0);
  } finally { release(); await f.close(); }
});

test('stopping the reaper awaits in-flight disconnection and overlapping runs share the same work', async () => {
  let entered!: () => void; let release!: () => void;
  const disconnecting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(now => name => {
    class SlowDisconnect extends FakePlatform {
      override async disconnect() { entered(); await blocked; await super.disconnect(); }
    }
    return new SlowDisconnect(name, {now});
  });
  try {
    const sessionId = f.sessions.create(f.a.id);
    await f.connections.start(f.a.id, 'telegram', sessionId);
    f.advance(600_001);
    const first = f.reaper.runOnce();
    assert.equal(f.reaper.runOnce(), first);
    await disconnecting;
    let stopped = false;
    const stopping = f.reaper.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(f.connectionRegistry.entries().length, 0);
    assert.equal(f.events.filter(event => event.action === 'connection_ended').length, 1);
  } finally { release(); await f.close(); }
});

test('platform failures never log QR values or contact details', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const secret = 'FAKE_QR:private-phone-and-contact';
  const f = await fixture(now => name => {
    class FailingPlatform extends FakePlatform {
      override async listGroups(): Promise<Array<{id: string; title: string}>> { throw new Error(secret); }
    }
    return new FailingPlatform(name, {now});
  });
  try {
    const cookie = await f.login(f.a);
    const connection = await f.start(cookie);
    f.advance(3_000);
    const response = await f.request('GET', `/connections/${connection.id}/groups`, cookie);
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes(secret), false);
    assert.equal(logger.mock.callCount(), 1);
    assert.equal(JSON.stringify(logger.mock.calls.map(call => call.arguments)).includes(secret), false);
    assert.equal(JSON.stringify(f.events).includes(secret), false);
  } finally { await f.close(); }
});

// ---------- POST /connections/:id/export (docs/specs/05-export.md) ----------

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return {promise, open};
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'condition not reached');
}
const exportActions = (events: Array<{action: string}>) => events.map(event => event.action)
  .filter(action => action.startsWith('export_') || action.startsWith('connection_'));
async function connected(f: Awaited<ReturnType<typeof fixture>>, platform: PlatformName = 'telegram') {
  const cookie = await f.login(f.a);
  const connection = await f.start(cookie, platform);
  f.advance(3_000);
  return {cookie, id: connection.id};
}
const groups = {groupIds: ['sample-group-1', 'sample-group-2']};

for (const [platform, sheets] of [
  ['telegram', ['Saved', 'Unsaved reachable', 'Unsaved unreachable']],
  ['whatsapp', ['Saved', 'Unsaved']],
] as const) {
  test(`${platform} export streams an xlsx, audits start/finish, then disconnects`, async () => {
    const f = await fixture();
    try {
      const {cookie, id} = await connected(f, platform);
      const platformObject = f.connectionRegistry.get(id)!.platform;
      const response = await f.request('POST', `/connections/${id}/export`, cookie, groups);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="contacts-${platform}-1970-01-01.xlsx"`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.arrayBuffer());
      assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), sheets);
      assert.ok(workbook.worksheets.every(sheet => sheet.rowCount === 2));
      assert.equal((await f.request('GET', `/connections/${id}`, cookie)).status, 404);
      assert.deepEqual(await platformObject.getStatus(), {status: 'disconnected'});
      const audit = f.events.filter(event => event.action !== 'login');
      assert.deepEqual(audit, ['connection_started', 'export_started', 'export_finished', 'connection_ended']
        .map(action => ({userId: f.a.id, action, platform, targetUserId: undefined})));
    } finally { await f.close(); }
  });
}

test('the filename uses the UTC date the export started', async () => {
  const f = await fixture();
  try {
    f.advance(Date.UTC(2026, 10, 20, 23, 59) - 3_000);
    const {cookie, id} = await connected(f);
    const response = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="contacts-telegram-2026-11-20.xlsx"');
    await response.arrayBuffer();
  } finally { await f.close(); }
});

test('export rejects bad groupIds and unknown groups, and never audits them', async () => {
  const f = await fixture();
  try {
    const {cookie, id} = await connected(f);
    for (const body of [{}, {groupIds: []}, {groupIds: 'sample-group-1'}, {groupIds: [1]}, {groupIds: ['']},
      {groupIds: ['x'.repeat(257)]}, {groupIds: ['sample-group-1', 'sample-group-1']},
      {groupIds: Array.from({length: 51}, (_, i) => `g${i}`)}, {groupIds: ['sample-group-1'], ownerId: f.b.id}]) {
      const response = await f.request('POST', `/connections/${id}/export`, cookie, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), {message: 'select between 1 and 50 groups'});
    }
    const unknown = await f.request('POST', `/connections/${id}/export`, cookie, {groupIds: ['sample-group-1', 'not-mine']});
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), {message: 'unknown group selected'});
    assert.equal(f.events.some(event => event.action.startsWith('export_')), false);
    assert.equal(f.connectionRegistry.get(id)!.exporting, false);
  } finally { await f.close(); }
});

test('export enforces auth, temporary password, ownership, and connected status', async () => {
  const f = await fixture();
  try {
    const cookieA = await f.login(f.a); const cookieB = await f.login(f.b);
    const {id} = await f.start(cookieA);
    const notConnected = await f.request('POST', `/connections/${id}/export`, cookieA, groups);
    assert.equal(notConnected.status, 409);
    assert.deepEqual(await notConnected.json(), {message: 'connection is not connected yet'});
    f.advance(3_000);
    assert.equal((await f.request('POST', `/connections/${id}/export`, '', groups)).status, 401);
    for (const target of [id, 'missing']) {
      const response = await f.request('POST', `/connections/${target}/export`, cookieB, groups);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {message: 'connection not found'});
    }
    f.a.mustChangePassword = true;
    assert.equal((await f.request('POST', `/connections/${id}/export`, cookieA, groups)).status, 403);
    assert.ok(f.connectionRegistry.get(id));
    assert.equal(f.events.some(event => event.action.startsWith('export_')), false);
  } finally { await f.close(); }
});

test('a platform failure before streaming returns 502, keeps the connection, logs no details, and can be retried', async (t) => {
  const logger = t.mock.method(console, 'error', () => {});
  const secret = 'Alice +12025550101 @alice';
  let fail = true;
  const f = await fixture(now => name => {
    class Flaky extends FakePlatform {
      override async listContacts(groupIds: readonly string[]) {
        if (fail) throw new Error(secret);
        return super.listContacts(groupIds);
      }
    }
    return new Flaky(name, {now});
  });
  try {
    const {cookie, id} = await connected(f);
    const failed = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {message: 'could not read contacts from the platform; please try again'});
    assert.deepEqual(await (await f.request('GET', `/connections/${id}`, cookie)).json(), {id, platform: 'telegram', status: 'connected'});
    assert.equal(f.connectionRegistry.get(id)!.exporting, false);
    assert.equal(JSON.stringify(logger.mock.calls.map(call => call.arguments)).includes(secret), false);
    assert.equal(JSON.stringify(f.events).includes(secret), false);
    fail = false;
    const retried = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(retried.status, 200);
    await retried.arrayBuffer();
    assert.deepEqual(exportActions(f.events),
      ['connection_started', 'export_started', 'export_failed', 'export_started', 'export_finished', 'connection_ended']);
  } finally { await f.close(); }
});

test('a listGroups failure during export validation returns 502 without export audit rows', async (t) => {
  t.mock.method(console, 'error', () => {});
  let fail = false;
  const f = await fixture(now => name => {
    class Flaky extends FakePlatform {
      override async listGroups() { if (fail) throw new Error('down'); return super.listGroups(); }
    }
    return new Flaky(name, {now});
  });
  try {
    const {cookie, id} = await connected(f);
    fail = true;
    const response = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(response.status, 502);
    assert.ok(f.connectionRegistry.get(id));
    assert.equal(f.events.some(event => event.action.startsWith('export_')), false);
  } finally { await f.close(); }
});

function slowContacts(entered: ReturnType<typeof gate>, release: ReturnType<typeof gate>) {
  return (now: () => number): PlatformFactory => name => {
    class Slow extends FakePlatform {
      override async listContacts(groupIds: readonly string[]) {
        entered.open();
        await release.promise;
        return super.listContacts(groupIds);
      }
    }
    return new Slow(name, {now});
  };
}

test('while an export is fetching: a second export gets 409, status is not blocked, and the reaper skips it', async () => {
  const entered = gate(); const release = gate();
  const f = await fixture(slowContacts(entered, release));
  try {
    const {cookie, id} = await connected(f);
    const first = f.request('POST', `/connections/${id}/export`, cookie, groups);
    await entered.promise;
    const second = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), {message: 'an export is already running'});
    assert.equal((await f.request('GET', `/connections/${id}`, cookie)).status, 200);
    assert.equal((await f.request('GET', `/connections/${id}/groups`, cookie)).status, 200);
    f.advance(700_000);
    await f.reaper.runOnce();
    assert.ok(f.connectionRegistry.get(id), 'reaper must not end an exporting connection');
    release.open();
    const response = await first;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(exportActions(f.events), ['connection_started', 'export_started', 'export_finished', 'connection_ended']);
  } finally { release.open(); await f.close(); }
});

test('DELETE while an export is fetching ends the connection once and the export returns 404', async () => {
  const entered = gate(); const release = gate();
  const f = await fixture(slowContacts(entered, release));
  try {
    const {cookie, id} = await connected(f);
    const exporting = f.request('POST', `/connections/${id}/export`, cookie, groups);
    await entered.promise;
    assert.equal((await f.request('DELETE', `/connections/${id}`, cookie)).status, 204);
    release.open();
    const response = await exporting;
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {message: 'connection not found'});
    assert.deepEqual(exportActions(f.events), ['connection_started', 'export_started', 'connection_ended', 'export_failed']);
  } finally { release.open(); await f.close(); }
});

function partialWriter(after: (out: Writable) => Promise<void>) {
  const writer = new ExcelWriter();
  writer.write = async (_contacts, out) => {
    await new Promise<void>((resolve, reject) => out.write(Buffer.alloc(64 * 1024, 1), error => error ? reject(error) : resolve()));
    await after(out);
  };
  return new ExportService(writer);
}

test('a writer failure after streaming began cuts the download off and ends the connection', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = await fixture(undefined, partialWriter(async () => { throw new Error('writer broke'); }));
  try {
    const {cookie, id} = await connected(f);
    const response = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer());
    await waitFor(() => f.events.some(event => event.action === 'connection_ended'));
    assert.equal(f.connectionRegistry.get(id), undefined);
    assert.deepEqual(exportActions(f.events), ['connection_started', 'export_started', 'export_failed', 'connection_ended']);
  } finally { await f.close(); }
});

test('DELETE while the file is streaming cuts the download off and ends the connection once', async (t) => {
  t.mock.method(console, 'error', () => {});
  const streaming = gate();
  const f = await fixture(undefined, partialWriter(async out => {
    streaming.open();
    if (!out.destroyed) await once(out, 'close');
    throw new Error('closed');
  }));
  try {
    const {cookie, id} = await connected(f);
    const response = await f.request('POST', `/connections/${id}/export`, cookie, groups);
    assert.equal(response.status, 200);
    await streaming.promise;
    assert.equal((await f.request('DELETE', `/connections/${id}`, cookie)).status, 204);
    await assert.rejects(response.arrayBuffer());
    await waitFor(() => f.events.some(event => event.action === 'export_failed'));
    assert.deepEqual(exportActions(f.events), ['connection_started', 'export_started', 'connection_ended', 'export_failed']);
  } finally { streaming.open(); await f.close(); }
});

test('the client aborting mid-download is audited as export_failed and ends the connection', async (t) => {
  t.mock.method(console, 'error', () => {});
  const streaming = gate();
  const f = await fixture(undefined, partialWriter(async out => {
    streaming.open();
    if (!out.destroyed) await once(out, 'close');
    throw new Error('client went away');
  }));
  try {
    const {cookie, id} = await connected(f);
    // node:http lets the test drop the socket the way a closing browser tab does.
    const body = JSON.stringify(groups);
    const request = http.request(`${f.origin}/connections/${id}/export`, {
      method: 'POST', agent: false, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie},
    });
    request.on('error', () => {});
    request.end(body);
    const [response] = await once(request, 'response') as [http.IncomingMessage];
    assert.equal(response.statusCode, 200);
    await streaming.promise;
    request.destroy();
    await waitFor(() => f.events.some(event => event.action === 'connection_ended'));
    assert.equal(f.connectionRegistry.get(id), undefined);
    assert.deepEqual(exportActions(f.events), ['connection_started', 'export_started', 'export_failed', 'connection_ended']);
  } finally { streaming.open(); await f.close(); }
});

// ---------- Two-step verification and start failures (docs/specs/06-telegram.md 3.2, 3.3) ----------

const twoFactorSecret = 'Correct-2FA-secret-value';
const twoFactorFixture = () => fixture(now => name => createPlatform(name, {now, password: twoFactorSecret, passwordHint: 'pet name'}));
async function awaitingPassword(f: Awaited<ReturnType<typeof fixture>>) {
  const cookie = await f.login(f.a);
  const connection = await f.start(cookie);
  f.advance(3_000);
  return {cookie, id: connection.id, submit: (body: unknown) => f.request('POST', `/connections/${connection.id}/password`, cookie, body)};
}

test('password step: password-required with the hint, a wrong password keeps it, the right one connects', async (t) => {
  const logs = [t.mock.method(console, 'error', () => {}), t.mock.method(console, 'log', () => {})];
  const f = await twoFactorFixture();
  try {
    const {cookie, id, submit} = await awaitingPassword(f);
    assert.deepEqual(await (await f.request('GET', `/connections/${id}`, cookie)).json(),
      {id, platform: 'telegram', status: 'password-required', passwordHint: 'pet name'});
    assert.equal((await f.request('GET', `/connections/${id}/groups`, cookie)).status, 409);
    const wrong = await submit({password: 'Wrong-secret-value'});
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), {message: 'wrong two-step verification password'});
    assert.equal((await (await f.request('GET', `/connections/${id}`, cookie)).json() as {status: string}).status, 'password-required');
    const right = await submit({password: twoFactorSecret});
    assert.equal(right.status, 200);
    assert.equal(right.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await right.json(), {id, platform: 'telegram', status: 'connected'});
    assert.equal((await f.request('GET', `/connections/${id}/groups`, cookie)).status, 200);
    const again = await submit({password: twoFactorSecret});
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), {message: 'connection is not waiting for a password'});
    const logged = JSON.stringify(logs.flatMap(log => log.mock.calls.map(call => call.arguments)));
    assert.doesNotMatch(logged, /2FA-secret|Wrong-secret|pet name/);
    assert.doesNotMatch(JSON.stringify(f.events), /secret|pet name/i);
    assert.deepEqual(f.events.filter(event => event.action.startsWith('connection_')).map(event => event.action), ['connection_started']);
  } finally { await f.close(); }
});

test('password step: the 5th wrong password ends the connection once', async () => {
  const f = await twoFactorFixture();
  try {
    const {cookie, id, submit} = await awaitingPassword(f);
    for (let attempt = 1; attempt <= 4; attempt++) {
      assert.deepEqual(await (await submit({password: `wrong-${attempt}`})).json(), {message: 'wrong two-step verification password'});
    }
    const fifth = await submit({password: 'wrong-5'});
    assert.equal(fifth.status, 400);
    assert.deepEqual(await fifth.json(), {message: 'too many wrong passwords; start again'});
    assert.equal(f.connectionRegistry.get(id), undefined);
    assert.equal((await f.request('GET', `/connections/${id}`, cookie)).status, 404);
    assert.equal((await submit({password: twoFactorSecret})).status, 404);
    assert.deepEqual(f.events.filter(event => event.action.startsWith('connection_')).map(event => event.action),
      ['connection_started', 'connection_ended']);
  } finally { await f.close(); }
});

test('password step: validation, ownership, auth, and platforms without a password step', async () => {
  const f = await twoFactorFixture();
  try {
    const {id, submit} = await awaitingPassword(f);
    for (const body of [{}, {password: ''}, {password: 'x'.repeat(257)}, {password: 123}, {password: 'ok', extra: 1}, []]) {
      const response = await submit(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), {message: 'password is required'});
    }
    const otherUser = await f.login(f.b);
    assert.equal((await f.request('POST', `/connections/${id}/password`, otherUser, {password: twoFactorSecret})).status, 404);
    assert.equal((await f.request('POST', `/connections/${'0'.repeat(64)}/password`, otherUser, {password: 'x'})).status, 404);
    assert.equal((await f.request('POST', `/connections/${id}/password`, '', {password: twoFactorSecret})).status, 401);
    assert.equal((await submit({password: 'x'.repeat(256)})).status, 400); // 256 characters is allowed, just wrong
  } finally { await f.close(); }
  const plain = await fixture();
  try {
    for (const platform of ['telegram', 'whatsapp'] as const) {
      const cookie = await plain.login(plain.a);
      const connection = await plain.start(cookie, platform);
      const submit = () => plain.request('POST', `/connections/${connection.id}/password`, cookie, {password: 'anything'});
      assert.equal((await submit()).status, 409); // still waiting for the scan
      plain.advance(3_000);
      assert.equal((await submit()).status, 409); // connected, no password step
    }
  } finally { await plain.close(); }
});

test('password step: a platform failure returns 502 and keeps the password step', async () => {
  const f = await fixture(now => name => {
    class FlakyPlatform extends FakePlatform {
      override async submitPassword(): Promise<void> { throw new Error('FLOOD_WAIT'); }
    }
    return new FlakyPlatform(name, {now, password: twoFactorSecret});
  });
  try {
    const {cookie, id, submit} = await awaitingPassword(f);
    const response = await submit({password: twoFactorSecret});
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {message: 'could not reach the platform; please try again'});
    assert.equal((await (await f.request('GET', `/connections/${id}`, cookie)).json() as {status: string}).status, 'password-required');
  } finally { await f.close(); }
});

test('POST /connections returns 502 when the platform cannot produce a QR code, keeping and auditing nothing', async () => {
  const disconnected: string[] = [];
  const f = await fixture(now => name => {
    class UnreachablePlatform extends FakePlatform {
      override async connect(): Promise<void> { throw new PlatformError('unavailable'); }
      override async disconnect(): Promise<void> { disconnected.push(name); }
    }
    return new UnreachablePlatform(name, {now});
  });
  try {
    const cookie = await f.login(f.a);
    const response = await f.request('POST', '/connections', cookie, {platform: 'telegram'});
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {message: 'could not reach the platform; please try again'});
    assert.deepEqual(disconnected, ['telegram']);
    assert.deepEqual(f.connectionRegistry.entries(), []);
    assert.equal(f.events.some(event => event.action.startsWith('connection_')), false);
  } finally { await f.close(); }
});
