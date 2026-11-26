import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { PlatformError } from '../src/platforms/platform.errors.js';
import {
  TelegramPlatform, readDialogPage, selectTelegramGroups,
  type TelegramChatRecord, type TelegramClientAdapter, type TelegramDialogPage, type TelegramLoginCallbacks,
} from '../src/platforms/telegram/telegram.platform.js';
import { TelegramThrottle } from '../src/platforms/telegram/telegram.throttle.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** A fake clock whose sleep advances time, recording every wait. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    advance(ms: number) { time += ms; },
    sleeps,
  };
}

// ---------- selectTelegramGroups (pure filter, spec 06 4.4) ----------

test('the group filter keeps basic groups and supergroups, in dialog order, once each', () => {
  const chats: TelegramChatRecord[] = [
    { kind: 'channel', id: '-1001', title: 'Supergroup', megagroup: true },
    { kind: 'chat', id: '-2', title: 'Basic group' },
    { kind: 'channel', id: '-1003', title: 'Broadcast channel', megagroup: false },
    { kind: 'chat', id: '-4', title: 'Migrated basic group', migrated: true },
    { kind: 'chat', id: '-5', title: 'Deactivated group', deactivated: true },
    { kind: 'chat', id: '-6', title: 'Left basic group', left: true },
    { kind: 'channel', id: '-1007', title: 'Left supergroup', megagroup: true, left: true },
    { kind: 'unavailable', id: '', title: '' },
    { kind: 'channel', id: '-1001', title: 'Supergroup', megagroup: true },
  ];
  assert.deepEqual(selectTelegramGroups(chats), [
    { id: '-1001', title: 'Supergroup' },
    { id: '-2', title: 'Basic group' },
  ]);
  assert.deepEqual(selectTelegramGroups([]), []);
});

// ---------- TelegramThrottle (spec 06 4.6) ----------

test('the throttle runs one request at a time with at least the gap between starts', async () => {
  const clock = fakeClock();
  const throttle = new TelegramThrottle({ gapMs: 1_000, now: clock.now, sleep: clock.sleep });
  const starts: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const request = (value: number) => throttle.run(async () => {
    starts.push(clock.now());
    running += 1; maxRunning = Math.max(maxRunning, running);
    await tick();
    clock.advance(200); // the request itself takes 200 ms
    running -= 1;
    return value;
  });
  assert.deepEqual(await Promise.all([request(1), request(2), request(3)]), [1, 2, 3]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(starts.map(start => start - starts[0]!), [0, 1_000, 2_000]);
  assert.deepEqual(clock.sleeps, [800, 800]);
});

test('the throttle keeps going after an ordinary failure', async () => {
  const clock = fakeClock();
  const throttle = new TelegramThrottle({ now: clock.now, sleep: clock.sleep });
  await assert.rejects(throttle.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await throttle.run(async () => 'ok'), 'ok');
});

test('after a long flood wait every request fails at once without calling Telegram, until the deadline', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const clock = fakeClock();
  const throttle = new TelegramThrottle({ now: clock.now, sleep: clock.sleep });
  const flood = Object.assign(new Error('A wait of 120 seconds is required'), { errorMessage: 'FLOOD_WAIT', seconds: 120 });
  await assert.rejects(throttle.run(async () => { throw flood; }), error => error === flood);
  let calls = 0;
  const call = () => throttle.run(async () => { calls += 1; return 'ok'; });
  await assert.rejects(call(), (error: unknown) => error instanceof PlatformError && error.code === 'unavailable');
  clock.advance(119_000);
  await assert.rejects(call(), PlatformError);
  assert.equal(calls, 0);
  clock.advance(1_000);
  assert.equal(await call(), 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(errors.mock.calls.map(c => c.arguments), [['Telegram flood wait', { seconds: 120 }]]);
});

// ---------- TelegramPlatform.listGroups ----------

class PagingClient implements TelegramClientAdapter {
  offsets: unknown[] = [];
  constructor(private readonly pages: Array<TelegramDialogPage | Error>) {}
  async connect() {}
  loginWithQr(callbacks: TelegramLoginCallbacks) {
    return callbacks.qrCode(Buffer.from('t')); // resolves at once: logged in without 2FA
  }
  async getDialogs(offset?: unknown) {
    this.offsets.push(offset);
    const page = this.pages.shift();
    if (!page) throw new Error('no more pages');
    if (page instanceof Error) throw page;
    return page;
  }
  async isChannelHidden() { return false; }
  async getChatMembers() { return { members: [], hidden: false }; }
  async getChannelMembers() { return { members: [], returned: 0, count: 0 }; }
  async logOut() {}
  async destroy() {}
}

async function connectedPlatform(pages: Array<TelegramDialogPage | Error>) {
  const clock = fakeClock();
  const client = new PagingClient(pages);
  const platform = new TelegramPlatform({ makeClient: () => client, throttle: new TelegramThrottle({ now: clock.now, sleep: clock.sleep }) });
  await platform.connect();
  await tick();
  assert.equal((await platform.getStatus()).status, 'connected');
  return { client, platform, clock };
}

const teamRef = { kind: 'channel', channelId: '1', accessHash: '10' } as const;

test('listGroups pages through the dialogs, one throttled request per page, and filters them', async () => {
  const { client, platform, clock } = await connectedPlatform([
    { chats: [{ kind: 'channel', id: '-1001', title: 'Team', megagroup: true, ref: teamRef }, { kind: 'channel', id: '-1002', title: 'News', megagroup: false, ref: { kind: 'channel', channelId: '2', accessHash: '20' } }], next: 'offset-1' },
    { chats: [{ kind: 'chat', id: '-3', title: 'Family', ref: { kind: 'chat', chatId: '3' } }], next: 'offset-2' },
    { chats: [{ kind: 'channel', id: '-1001', title: 'Team', megagroup: true, ref: teamRef }] },
  ]);
  assert.deepEqual(await platform.listGroups(), [{ id: '-1001', title: 'Team' }, { id: '-3', title: 'Family' }]);
  assert.deepEqual(client.offsets, [undefined, 'offset-1', 'offset-2']);
  assert.deepEqual(clock.sleeps, [1_000, 1_000]);
});

test('listGroups refuses before login and logs only the error code on failure', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const idle = new TelegramPlatform({ makeClient: () => new PagingClient([]) });
  await assert.rejects(idle.listGroups(), /not connected/);
  const { platform } = await connectedPlatform([
    Object.assign(new Error('chat "Secret family group" +12025550101'), { errorMessage: 'INTERNAL_SERVER_ERROR' }),
  ]);
  await assert.rejects(platform.listGroups());
  const logged = JSON.stringify(errors.mock.calls.map(c => c.arguments));
  assert.match(logged, /Telegram listGroups failed.*INTERNAL_SERVER_ERROR/);
  assert.doesNotMatch(logged, /Secret family|12025550101/);
  await platform.disconnect();
});

// ---------- readDialogPage against real GramJS objects (no network) ----------

const long = (value: number) => returnBigInt(value);
function dialog(peer: Api.TypePeer, topMessage: number) {
  return new Api.Dialog({ peer, topMessage, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0,
    unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
}
const supergroup = new Api.Channel({ id: long(111), accessHash: long(9), title: 'Supergroup', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 1 });
const channel = new Api.Channel({ id: long(222), accessHash: long(8), title: 'Channel', broadcast: true, photo: new Api.ChatPhotoEmpty(), date: 1 });
const basic = new Api.Chat({ id: long(333), title: 'Basic', photo: new Api.ChatPhotoEmpty(), participantsCount: 3, date: 1, version: 1 });
const migrated = new Api.Chat({ id: long(444), title: 'Old', photo: new Api.ChatPhotoEmpty(), participantsCount: 3, date: 1, version: 1,
  migratedTo: new Api.InputChannel({ channelId: long(111), accessHash: long(9) }) });
const person = new Api.User({ id: long(555), accessHash: long(7), firstName: 'Private chat' });
const message = (peerId: Api.TypePeer, id: number, date: number) => new Api.Message({ id, peerId, date, message: 'hidden text' });

test('readDialogPage maps chats, skips private chats, and builds the next offset from the last dialog', async () => {
  const requests: Api.messages.GetDialogs[] = [];
  const dialogs = [
    dialog(new Api.PeerChannel({ channelId: long(111) }), 10),
    dialog(new Api.PeerUser({ userId: long(555) }), 20),
    dialog(new Api.PeerChannel({ channelId: long(222) }), 30),
    dialog(new Api.PeerChat({ chatId: long(444) }), 40),
    dialog(new Api.PeerChat({ chatId: long(333) }), 50),
  ];
  const page = new Api.messages.DialogsSlice({
    count: 500, dialogs: [...dialogs, ...Array.from({ length: 95 }, () => dialog(new Api.PeerUser({ userId: long(555) }), 20))],
    messages: [message(new Api.PeerChannel({ channelId: long(111) }), 10, 1_700), message(new Api.PeerChat({ chatId: long(333) }), 50, 1_600)],
    chats: [supergroup, channel, basic, migrated], users: [person],
  });
  // The 95 filler dialogs are private chats whose top message is missing: the offset falls back to the last dialog with one.
  const client = { invoke: async (request: unknown) => { requests.push(request as Api.messages.GetDialogs); return page; } };
  const first = await readDialogPage(client as never, undefined);
  assert.deepEqual(first.chats.map(chat => [chat.kind, chat.id, chat.title, chat.migrated ?? chat.megagroup]), [
    ['channel', '-100111', 'Supergroup', true],
    ['channel', '-100222', 'Channel', undefined], // broadcast: Telegram doesn't set the megagroup flag
    ['chat', '-444', 'Old', true],
    ['chat', '-333', 'Basic', false],
  ]);
  // The supergroup has no participantsCount in the dialog list, so it gets no memberCount.
  assert.deepEqual(selectTelegramGroups(first.chats), [{ id: '-100111', title: 'Supergroup' }, { id: '-333', title: 'Basic', memberCount: 3 }]);
  const next = first.next as { date: number; id: number; peer: unknown };
  assert.equal(next.date, 1_600);
  assert.equal(next.id, 50);
  assert.equal(next.peer, person); // the peer of the very last dialog
  assert.equal(requests[0]!.limit, 100);
  assert.equal(requests[0]!.excludePinned, false);
  assert.ok(requests[0]!.offsetPeer instanceof Api.InputPeerEmpty);
  assert.doesNotMatch(JSON.stringify(first.chats), /hidden text|Private chat/);

  await readDialogPage(client as never, next as never);
  assert.equal(requests[1]!.offsetDate, 1_600);
  assert.equal(requests[1]!.offsetId, 50);
  assert.equal(requests[1]!.excludePinned, true);
});

test('a basic group whose absent fields arrive as null (as Telegram sends them) is kept', async () => {
  // Regression (2026-11-23): GramJS deserializes absent optional fields as null; `migratedTo: null` made every
  // basic group look migrated, so a real owned basic group was missing from GET /groups.
  const owned = new Api.Chat({ id: long(5452073554), title: 'coworkers', creator: true, photo: new Api.ChatPhotoEmpty(),
    participantsCount: 4, date: 1, version: 1 });
  for (const field of ['migratedTo', 'left', 'deactivated', 'adminRights', 'defaultBannedRights']) {
    (owned as unknown as Record<string, unknown>)[field] = null;
  }
  const page = new Api.messages.Dialogs({ dialogs: [dialog(new Api.PeerChat({ chatId: long(5452073554) }), 1)],
    messages: [], chats: [owned], users: [] });
  const { chats } = await readDialogPage({ invoke: async () => page } as never, undefined);
  assert.deepEqual(selectTelegramGroups(chats), [{ id: '-5452073554', title: 'coworkers', memberCount: 4 }]);
});

test('readDialogPage stops on a complete list or a short page', async () => {
  const complete = new Api.messages.Dialogs({ dialogs: [dialog(new Api.PeerChat({ chatId: long(333) }), 50)],
    messages: [message(new Api.PeerChat({ chatId: long(333) }), 50, 1)], chats: [basic], users: [] });
  assert.equal((await readDialogPage({ invoke: async () => complete } as never, undefined)).next, undefined);
  const short = new Api.messages.DialogsSlice({ count: 500, dialogs: complete.dialogs, messages: complete.messages, chats: [basic], users: [] });
  assert.equal((await readDialogPage({ invoke: async () => short } as never, undefined)).next, undefined);
});

test('chat records carry the IDs member requests need; a supergroup without an access hash is not listed', async () => {
  const noHash = new Api.Channel({ id: long(666), title: 'No hash', megagroup: true, photo: new Api.ChatPhotoEmpty(), date: 1 });
  (noHash as unknown as Record<string, unknown>).accessHash = null; // as Telegram sends a "min" channel
  const page = new Api.messages.Dialogs({
    dialogs: [dialog(new Api.PeerChannel({ channelId: long(111) }), 10), dialog(new Api.PeerChat({ chatId: long(333) }), 50), dialog(new Api.PeerChannel({ channelId: long(666) }), 60)],
    messages: [], chats: [supergroup, basic, noHash], users: [] });
  const { chats } = await readDialogPage({ invoke: async () => page } as never, undefined);
  assert.deepEqual(chats.map(chat => chat.ref), [
    { kind: 'channel', channelId: '111', accessHash: '9' },
    { kind: 'chat', chatId: '333' },
    undefined,
  ]);
  const { platform } = await connectedPlatform([{ chats }]);
  assert.deepEqual(await platform.listGroups(), [{ id: '-100111', title: 'Supergroup' }, { id: '-333', title: 'Basic', memberCount: 3 }]);
  await platform.disconnect();
});
