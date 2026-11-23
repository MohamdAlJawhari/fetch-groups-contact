import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { PlatformError } from '../src/platforms/platform.errors.js';
import type { TelegramMember } from '../src/platforms/telegram/telegram.categorizer.js';
import {
  TelegramPlatform, isChannelHidden, readChannelMembers, readChatMembers, toTelegramMember,
  type TelegramChatRecord, type TelegramClientAdapter, type TelegramGroupRef, type TelegramLoginCallbacks, type TelegramMemberPage,
} from '../src/platforms/telegram/telegram.platform.js';
import { TelegramThrottle } from '../src/platforms/telegram/telegram.throttle.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const long = (value: number | string) => returnBigInt(value);
const isHidden = (ids: string[]) => (error: unknown) => error instanceof PlatformError && error.code === 'members_hidden'
  && JSON.stringify(error.groupIds) === JSON.stringify(ids);
const rpc = (errorMessage: string) => Object.assign(new Error(errorMessage), { errorMessage });

const basicGroup: TelegramChatRecord = { kind: 'chat', id: '-5', title: 'Basic', ref: { kind: 'chat', chatId: '5' } };
const supergroup: TelegramChatRecord = { kind: 'channel', id: '-1007', title: 'Super', megagroup: true, ref: { kind: 'channel', channelId: '7', accessHash: '70' } };
const hiddenGroup: TelegramChatRecord = { kind: 'channel', id: '-1008', title: 'Hidden', megagroup: true, ref: { kind: 'channel', channelId: '8', accessHash: '80' } };
const member = (id: string, extra: Partial<TelegramMember> = {}): TelegramMember => ({ id, firstName: `Member ${id}`, ...extra });

/** A scripted Telegram: groups, which supergroups are hidden, and members per group (served in pages of `pageSize`). */
class MembersClient implements TelegramClientAdapter {
  calls: string[] = [];
  hidden = new Set<string>();
  failWith = new Map<string, Error>();
  constructor(private readonly chats: TelegramChatRecord[], private readonly members: Record<string, TelegramMember[]>, private readonly pageSize = 2) {}
  async connect() {}
  loginWithQr(callbacks: TelegramLoginCallbacks) { return callbacks.qrCode(Buffer.from('t')); }
  async getDialogs() { this.calls.push('dialogs'); return { chats: this.chats }; }
  async isChannelHidden(ref: Extract<TelegramGroupRef, { kind: 'channel' }>) {
    this.calls.push(`full:${ref.channelId}`);
    const failure = this.failWith.get(`full:${ref.channelId}`);
    if (failure) throw failure;
    return this.hidden.has(ref.channelId);
  }
  async getChatMembers(ref: Extract<TelegramGroupRef, { kind: 'chat' }>) {
    this.calls.push(`chat:${ref.chatId}`);
    return { members: this.members[ref.chatId] ?? [], hidden: false };
  }
  async getChannelMembers(ref: Extract<TelegramGroupRef, { kind: 'channel' }>, offset: number): Promise<TelegramMemberPage> {
    this.calls.push(`page:${ref.channelId}@${offset}`);
    const failure = this.failWith.get(`page:${ref.channelId}`);
    if (failure) throw failure;
    const all = this.members[ref.channelId] ?? [];
    const slice = all.slice(offset, offset + this.pageSize);
    return { members: slice, returned: slice.length, count: all.length };
  }
  async logOut() {}
  async destroy() {}
}

async function connected(client: MembersClient) {
  let time = 0;
  const sleeps: number[] = [];
  const throttle = new TelegramThrottle({ now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; } });
  const platform = new TelegramPlatform({ makeClient: () => client, throttle });
  await platform.connect();
  await tick();
  await platform.listGroups();
  client.calls = [];
  return { platform, sleeps };
}

test('listContacts checks hidden supergroups first, then fetches every group page by page, throttled, and categorizes', async () => {
  const client = new MembersClient([basicGroup, supergroup], {
    5: [member('1', { contact: true }), member('2', { username: 'two' })],
    7: [member('3'), member('4', { phone: '9611' }), member('5', { bot: true }), member('2', { username: 'two' })],
  });
  const { platform, sleeps } = await connected(client);
  const result = await platform.listContacts(['-5', '-1007']);
  assert.deepEqual(client.calls, ['full:7', 'chat:5', 'page:7@0', 'page:7@2']);
  assert.ok(sleeps.length >= 3, 'every request after the first waits for the throttle');
  assert.deepEqual(result.map(({ category, contacts }) => [category, contacts.map(contact => contact.id)]), [
    ['saved', ['1']],
    ['unsaved_reachable', ['2', '4', '2']], // cross-group duplicates are ExportService's job (spec 05, 4.2)
    ['unsaved_unreachable', ['3']],
  ]);
});

test('hidden supergroups reject the export with exactly their IDs, before any member is fetched', async () => {
  const client = new MembersClient([basicGroup, supergroup, hiddenGroup], { 5: [member('1')], 7: [member('2')], 8: [member('3')] });
  client.hidden.add('8');
  client.failWith.set('full:7', rpc('CHAT_ADMIN_REQUIRED'));
  const { platform } = await connected(client);
  await assert.rejects(platform.listContacts(['-5', '-1007', '-1008']), isHidden(['-1007', '-1008']));
  assert.deepEqual(client.calls, ['full:7', 'full:8']);
});

test('CHAT_ADMIN_REQUIRED while fetching members also means hidden, for that group only', async () => {
  const client = new MembersClient([supergroup], { 7: [member('1')] });
  client.failWith.set('page:7', rpc('CHAT_ADMIN_REQUIRED'));
  const { platform } = await connected(client);
  await assert.rejects(platform.listContacts(['-1007']), isHidden(['-1007']));
});

test('other failures are passed on and logged by code only', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const client = new MembersClient([supergroup], { 7: [member('1')] });
  client.failWith.set('page:7', Object.assign(new Error('member Ali +9613123456'), { errorMessage: 'INTERNAL_SERVER_ERROR' }));
  const { platform } = await connected(client);
  await assert.rejects(platform.listContacts(['-1007']), /member Ali/);
  const logged = JSON.stringify(errors.mock.calls.map(call => call.arguments));
  assert.match(logged, /Telegram listContacts failed.*INTERNAL_SERVER_ERROR/);
  assert.doesNotMatch(logged, /Ali|9613123456/);
});

test('listContacts reloads the group list when a group is unknown, and refuses before login', async () => {
  const client = new MembersClient([basicGroup], { 5: [member('1')] });
  const { platform } = await connected(client);
  await assert.rejects(platform.listContacts(['-999']), /Unknown Telegram group/);
  assert.deepEqual(client.calls, ['dialogs']);
  const idle = new TelegramPlatform({ makeClient: () => client });
  await assert.rejects(idle.listContacts(['-5']), /not connected/);
});

test('a supergroup larger than Telegram returns stops when a page comes back empty', async () => {
  const client = new MembersClient([supergroup], { 7: [member('1'), member('2'), member('3')] });
  const original = client.getChannelMembers.bind(client);
  // Telegram reports 10 members but only ever returns 3.
  client.getChannelMembers = async (ref, offset) => ({ ...(await original(ref, offset)), count: 10 });
  const { platform } = await connected(client);
  const result = await platform.listContacts(['-1007']);
  assert.equal(result.flatMap(entry => entry.contacts).length, 3);
  assert.deepEqual(client.calls, ['full:7', 'page:7@0', 'page:7@2', 'page:7@3']);
});

// ---------- Mapping real GramJS objects (no network) ----------

const user = (id: number, fields: Partial<ConstructorParameters<typeof Api.User>[0]> = {}) => new Api.User({ id: long(id), ...fields });

test('toTelegramMember copies only categorizer fields and accepts null fields', () => {
  const full = user(11, { firstName: 'Ali', lastName: 'Hassan', phone: '9613123456', username: 'ali', contact: true, accessHash: long(5),
    usernames: [new Api.Username({ username: 'ali_collectible', active: true })] });
  assert.deepEqual(toTelegramMember(full), {
    id: '11', firstName: 'Ali', lastName: 'Hassan', phone: '9613123456', username: 'ali',
    usernames: [{ username: 'ali_collectible', active: true }], contact: true, self: undefined, deleted: undefined, bot: undefined,
  });
  const sparse = user(12);
  for (const field of ['firstName', 'lastName', 'phone', 'username', 'usernames', 'contact']) (sparse as unknown as Record<string, unknown>)[field] = null;
  assert.equal(toTelegramMember(sparse)?.usernames, null);
  assert.equal(toTelegramMember(new Api.UserEmpty({ id: long(13) })), undefined);
});

test('basic-group members exclude inviters that Telegram also sends in users[]', () => {
  const result = new Api.messages.ChatFull({
    fullChat: new Api.ChatFull({ id: long(5), about: '', participants: new Api.ChatParticipants({ chatId: long(5), version: 1, participants: [
      new Api.ChatParticipantCreator({ userId: long(1) }),
      new Api.ChatParticipant({ userId: long(2), inviterId: long(99), date: 1 }),
    ] }), notifySettings: new Api.PeerNotifySettings({}) }),
    chats: [], users: [user(1, { firstName: 'Owner' }), user(2, { firstName: 'Member' }), user(99, { firstName: 'Inviter who left' })],
  });
  const { members, hidden } = readChatMembers(result);
  assert.equal(hidden, false);
  assert.deepEqual(members.map(entry => entry.firstName), ['Owner', 'Member']);
  const forbidden = new Api.messages.ChatFull({
    fullChat: new Api.ChatFull({ id: long(5), about: '', participants: new Api.ChatParticipantsForbidden({ chatId: long(5) }), notifySettings: new Api.PeerNotifySettings({}) }),
    chats: [], users: [],
  });
  assert.deepEqual(readChatMembers(forbidden), { members: [], hidden: true });
});

test('supergroup pages count participants, keep only members, and handle NotModified', () => {
  const page = new Api.channels.ChannelParticipants({ count: 450, chats: [], participants: [
    new Api.ChannelParticipant({ userId: long(1), date: 1 }),
    new Api.ChannelParticipantSelf({ userId: long(2), inviterId: long(99), date: 1 }),
    new Api.ChannelParticipantAdmin({ userId: long(3), promotedBy: long(1), date: 1, adminRights: new Api.ChatAdminRights({}) }),
  ], users: [user(1), user(2), user(3), user(99, { firstName: 'Inviter' })] });
  const result = readChannelMembers(page);
  assert.deepEqual(result.members.map(entry => entry.id), ['1', '2', '3']);
  assert.equal(result.returned, 3);
  assert.equal(result.count, 450);
  assert.deepEqual(readChannelMembers(new Api.channels.ChannelParticipantsNotModified()), { members: [], returned: 0, count: 0 });
});

test('isChannelHidden: hidden when Telegram says so, unless we are an admin of a list hidden from non-admins', () => {
  const channel = (fields: Partial<ConstructorParameters<typeof Api.Channel>[0]> = {}) => new Api.Channel({ id: long(7), title: 'g', photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true, ...fields });
  const full = (fields: Partial<ConstructorParameters<typeof Api.ChannelFull>[0]>, chat = channel()) => new Api.messages.ChatFull({
    fullChat: new Api.ChannelFull({ id: long(7), about: '', readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: long(0) }),
      notifySettings: new Api.PeerNotifySettings({}), exportedInvite: undefined, botInfo: [], pts: 0, ...fields }),
    chats: [chat], users: [],
  });
  assert.equal(isChannelHidden(full({ canViewParticipants: true })), false);
  assert.equal(isChannelHidden(full({})), true);
  assert.equal(isChannelHidden(full({ canViewParticipants: true, participantsHidden: true })), true);
  assert.equal(isChannelHidden(full({ canViewParticipants: true, participantsHidden: true }, channel({ creator: true }))), false);
  assert.equal(isChannelHidden(full({ canViewParticipants: true, participantsHidden: true }, channel({ adminRights: new Api.ChatAdminRights({}) }))), false);
});
