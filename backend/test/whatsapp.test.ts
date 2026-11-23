import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvironment } from '../src/config/env.schema.js';
import { PlatformError } from '../src/platforms/platform.errors.js';
import { categorizeWhatsAppMembers, type WhatsAppMember } from '../src/platforms/whatsapp/whatsapp.categorizer.js';
import {
  WhatsAppContactBook, WhatsAppPlatform, resolveWhatsAppMembers, selectWhatsAppGroups, toGroupRecord,
  type WhatsAppGroupRecord, type WhatsAppSessionFactory, type WhatsAppSocket, type WhatsAppSocketEvents,
} from '../src/platforms/whatsapp/whatsapp.platform.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const unavailable = (error: unknown) => error instanceof PlatformError && error.code === 'unavailable';

// ---------- Categorizer (spec 08, 4.6) ----------

test('WhatsApp categorizer: saved by address-book name; unsaved split by visible phone or username; always 3 categories', () => {
  assert.deepEqual(categorizeWhatsAppMembers([]).map(entry => entry.category), ['saved', 'unsaved_reachable', 'unsaved_unreachable']);
  const members: WhatsAppMember[] = [
    { id: 'pn:961111', phone: '961111', savedName: '  Ali (work) ', pushName: 'Ali' },
    { id: 'lid:1@lid', savedName: 'Saved but hidden number' },
    { id: 'pn:961222', phone: '+961222', pushName: ' Sara ' },
    { id: 'lid:2@lid', username: '@nour' },
    { id: 'lid:3@lid', pushName: 'Hidden person' },
    { id: 'lid:4@lid' },
  ];
  const [saved, reachable, unreachable] = categorizeWhatsAppMembers(members);
  assert.deepEqual(saved!.contacts, [
    { id: 'pn:961111', name: 'Ali (work)', phoneNumber: '+961111' },
    { id: 'lid:1@lid', name: 'Saved but hidden number' },
  ]);
  assert.deepEqual(reachable!.contacts, [
    { id: 'pn:961222', name: 'Sara', phoneNumber: '+961222' },
    { id: 'lid:2@lid', name: '', username: 'nour' },
  ]);
  assert.deepEqual(unreachable!.contacts, [{ id: 'lid:3@lid', name: 'Hidden person' }, { id: 'lid:4@lid', name: '' }]);
});

// ---------- Groups and member resolution (spec 08, 4.4 and 4.5) ----------

test('group selection drops community parents and sorts by title', () => {
  const groups: WhatsAppGroupRecord[] = [
    { id: 'b@g.us', subject: 'beta', participants: [] },
    { id: 'c@g.us', subject: 'Community parent', isCommunity: true, participants: [] },
    { id: 'a@g.us', subject: 'Alpha', participants: [] },
    { id: 'x@g.us', subject: 'éclair', participants: [] },
  ];
  assert.deepEqual(selectWhatsAppGroups(groups), [
    { id: 'a@g.us', title: 'Alpha' }, { id: 'b@g.us', title: 'beta' }, { id: 'x@g.us', title: 'éclair' },
  ]);
});

test('toGroupRecord normalizes JIDs and keeps only what the platform needs', () => {
  const record = toGroupRecord({
    id: '123@g.us', subject: 'Team', owner: undefined, isCommunity: false, desc: 'secret description',
    participants: [
      { id: '961111:12@s.whatsapp.net', admin: 'admin' },
      { id: '55@lid', phoneNumber: '961222@s.whatsapp.net', username: 'sara' },
    ],
  });
  assert.deepEqual(record, { id: '123@g.us', subject: 'Team', isCommunity: false, participants: [
    { id: '961111@s.whatsapp.net' },
    { id: '55@lid', phoneNumber: '961222@s.whatsapp.net', username: 'sara' },
  ] });
});

test('members: phone from PN JID, phoneNumber, LID mapping, or saved contact; saved matched by PN or LID; self skipped', async () => {
  const book = new WhatsAppContactBook();
  book.add([
    { id: '961111@s.whatsapp.net', name: 'Ali saved' },
    { id: '20@lid', name: 'Lid-only saved' },
    { id: '30@lid', phoneNumber: '961333@s.whatsapp.net', name: 'Saved with number' },
    { id: '961222@s.whatsapp.net', notify: 'Sara push' },
  ]);
  book.add([{ id: '961111@s.whatsapp.net', notify: 'Ali push' }]); // a later push name keeps the saved name
  const mapping: Record<string, string> = { '40@lid': '961444@s.whatsapp.net' };
  const members = await resolveWhatsAppMembers([
    { id: '961111@s.whatsapp.net' },
    { id: '10@lid', phoneNumber: '961222@s.whatsapp.net' },
    { id: '20@lid' },
    { id: '30@lid' },
    { id: '40@lid' },
    { id: '50@lid', username: 'nour' },
    { id: '999@s.whatsapp.net' },
    { id: '77@lid' },
  ], book, ['999@s.whatsapp.net', '77@lid'], async lid => mapping[lid]);
  assert.deepEqual(members, [
    { id: 'pn:961111', phone: '961111', savedName: 'Ali saved', pushName: 'Ali push' },
    { id: 'pn:961222', phone: '961222', pushName: 'Sara push' },
    { id: 'lid:20@lid', savedName: 'Lid-only saved' },
    { id: 'pn:961333', phone: '961333', savedName: 'Saved with number' },
    { id: 'pn:961444', phone: '961444' },
    { id: 'lid:50@lid', username: 'nour' },
  ]);
});

// ---------- WhatsAppPlatform with a scripted socket ----------

class FakeSocket implements WhatsAppSocket {
  calls: string[] = [];
  syncResult: Promise<void> = Promise.resolve();
  groups: WhatsAppGroupRecord[] = [];
  failLogout = false;
  constructor(readonly auth: unknown, readonly events: WhatsAppSocketEvents) {}
  async fetchGroups() { this.calls.push('groups'); return this.groups; }
  syncContacts() { this.calls.push('sync'); return this.syncResult; }
  async phoneForLid() { return undefined; }
  selfIds() { return ['999@s.whatsapp.net']; }
  async logout() { this.calls.push('logout'); if (this.failLogout) throw new Error('offline +961111'); }
  end() { this.calls.push('end'); }
}

function setup(options: { connectTimeoutMs?: number; contactsWaitMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const auths: unknown[] = [];
  let time = 0;
  const session: WhatsAppSessionFactory = {
    createAuth: () => { const auth = { id: auths.length }; auths.push(auth); return auth; },
    makeSocket: (auth, events) => { const socket = new FakeSocket(auth, events); sockets.push(socket); return socket; },
  };
  const platform = new WhatsAppPlatform({ session, now: () => time, connectTimeoutMs: options.connectTimeoutMs ?? 1_000, contactsWaitMs: options.contactsWaitMs ?? 1_000 });
  return { platform, sockets, auths, advance: (ms: number) => { time += ms; }, last: () => sockets[sockets.length - 1]! };
}

async function linked(s: ReturnType<typeof setup>) {
  const connecting = s.platform.connect();
  s.last().events.qr('QR-1');
  await connecting;
  s.last().events.open();
  await tick();
}

test('connect resolves on the first QR; a new QR replaces it; 515 restarts with the same auth; open connects', async () => {
  const s = setup();
  assert.deepEqual(await s.platform.getStatus(), { status: 'disconnected' });
  const connecting = s.platform.connect();
  s.last().events.qr('QR-1');
  await connecting;
  assert.deepEqual(await s.platform.getStatus(), { status: 'waiting-for-scan', qr: 'QR-1' });
  s.last().events.qr('QR-2');
  assert.deepEqual(await s.platform.getStatus(), { status: 'waiting-for-scan', qr: 'QR-2' });
  s.last().events.close(515);
  assert.equal(s.sockets.length, 2);
  assert.equal(s.sockets[1]!.auth, s.sockets[0]!.auth);
  assert.deepEqual(await s.platform.getStatus(), { status: 'waiting-for-scan' });
  s.sockets[0]!.events.open(); // a stale socket's events are ignored
  assert.equal((await s.platform.getStatus()).status, 'waiting-for-scan');
  s.last().events.open();
  assert.deepEqual(await s.platform.getStatus(), { status: 'connected' });
  await tick();
  assert.deepEqual(s.last().calls, ['sync']);
});

test('no QR in time → unavailable and the socket is ended', async () => {
  const s = setup({ connectTimeoutMs: 20 });
  await assert.rejects(s.platform.connect(), unavailable);
  assert.deepEqual(s.last().calls, ['end']);
  assert.equal((await s.platform.getStatus()).status, 'disconnected');
});

test('any other close code disconnects and logs only the code; repeated 515s stop after 3 restarts', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const s = setup();
  await linked(s);
  s.last().events.close(401);
  assert.equal((await s.platform.getStatus()).status, 'disconnected');
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), [['WhatsApp connection closed', { code: 401 }]]);

  const r = setup();
  const connecting = r.platform.connect();
  r.last().events.qr('QR');
  await connecting;
  for (let i = 0; i < 4; i++) r.last().events.close(515);
  assert.equal(r.sockets.length, 4);
  assert.equal((await r.platform.getStatus()).status, 'disconnected');
});

test('disconnect logs out only when linked, ends the socket, is idempotent, and never throws', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const waiting = setup();
  const connecting = waiting.platform.connect();
  waiting.last().events.qr('QR');
  await connecting;
  await waiting.platform.disconnect();
  await waiting.platform.disconnect();
  assert.deepEqual(waiting.last().calls, ['end']);

  const s = setup();
  await linked(s);
  s.last().failLogout = true;
  await s.platform.disconnect();
  assert.deepEqual(s.last().calls, ['sync', 'logout', 'end']);
  assert.equal((await s.platform.getStatus()).status, 'disconnected');
  s.last().events.open(); // events after disconnect are ignored
  assert.equal((await s.platform.getStatus()).status, 'disconnected');
  assert.doesNotMatch(JSON.stringify(errors.mock.calls.map(call => call.arguments)), /961111|offline/);
});

test('listGroups fetches once; listContacts reuses the 60 s cache, waits for the contacts sync, and categorizes', async () => {
  const s = setup();
  await linked(s);
  const socket = s.last();
  socket.groups = [
    { id: 'a@g.us', subject: 'Alpha', participants: [{ id: '961111@s.whatsapp.net' }, { id: '999@s.whatsapp.net' }, { id: '5@lid' }] },
    { id: 'p@g.us', subject: 'Parent', isCommunity: true, participants: [] },
  ];
  socket.events.contacts([{ id: '961111@s.whatsapp.net', name: 'Ali saved' }]);
  assert.deepEqual(await s.platform.listGroups(), [{ id: 'a@g.us', title: 'Alpha' }]);
  const result = await s.platform.listContacts(['a@g.us']);
  assert.deepEqual(socket.calls, ['sync', 'groups']);
  assert.deepEqual(result.map(entry => [entry.category, entry.contacts.map(contact => contact.id)]), [
    ['saved', ['pn:961111']], ['unsaved_reachable', []], ['unsaved_unreachable', ['lid:5@lid']],
  ]);
  s.advance(61_000);
  await s.platform.listContacts(['a@g.us']);
  assert.deepEqual(socket.calls, ['sync', 'groups', 'groups']);
  await assert.rejects(s.platform.listContacts(['p@g.us']), /Unknown WhatsApp group/);
});

test('listContacts fails with unavailable when the contacts sync fails or is too slow, and retries the sync next time', async (t) => {
  t.mock.method(console, 'error', () => {});
  const s = setup({ contactsWaitMs: 30 });
  const connecting = s.platform.connect();
  const socket = s.last();
  socket.syncResult = Promise.reject(new Error('no key'));
  socket.syncResult.catch(() => {});
  socket.events.qr('QR');
  await connecting;
  socket.events.open();
  await tick();
  socket.groups = [{ id: 'a@g.us', subject: 'Alpha', participants: [] }];
  await assert.rejects(s.platform.listContacts(['a@g.us']), unavailable);
  socket.syncResult = new Promise(() => {}); // never finishes
  await assert.rejects(s.platform.listContacts(['a@g.us']), unavailable);
  socket.syncResult = Promise.resolve();
  assert.equal((await s.platform.listContacts(['a@g.us'])).length, 3);
  assert.ok(socket.calls.filter(call => call === 'sync').length >= 3);
});

test('listGroups and listContacts refuse before linking', async () => {
  const s = setup();
  await assert.rejects(s.platform.listGroups(), /not connected/);
  await assert.rejects(s.platform.listContacts(['a@g.us']), /not connected/);
});

// ---------- Config (spec 08, 4.1) ----------

test('WHATSAPP_PLATFORM defaults to baileys, allows fake outside production, and refuses fake in production', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/app', COOKIE_SECRET: 'c'.repeat(32) };
  const keys = { TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef' };
  assert.equal(parseEnvironment(base).whatsappPlatform, 'baileys');
  assert.equal(parseEnvironment({ ...base, WHATSAPP_PLATFORM: '' }).whatsappPlatform, 'baileys');
  assert.equal(parseEnvironment({ ...base, WHATSAPP_PLATFORM: 'fake' }).whatsappPlatform, 'fake');
  assert.throws(() => parseEnvironment({ ...base, ...keys, NODE_ENV: 'production', WHATSAPP_PLATFORM: 'fake' }), /WHATSAPP_PLATFORM: Must be baileys/);
  assert.throws(() => parseEnvironment({ ...base, WHATSAPP_PLATFORM: 'other' }), /WHATSAPP_PLATFORM/);
});
