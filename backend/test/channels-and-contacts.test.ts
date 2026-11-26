// Telegram channels the account manages (docs/specs/06b-telegram-channels.md) and the phone contacts export
// (docs/specs/09-phone-contacts.md): the platform pieces and the writer. The HTTP side is in connections.test.ts.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { Api } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { ExcelWriter } from '../src/export/excel.writer.js';
import { ExportService } from '../src/export/export.service.js';
import type { AddressBook, Platform } from '../src/platforms/platform.types.js';
import { toTelegramAddressBook, type TelegramMember } from '../src/platforms/telegram/telegram.categorizer.js';
import {
  TelegramPlatform, readDialogPage, selectTelegramGroups,
  type TelegramChatRecord, type TelegramClientAdapter, type TelegramLoginCallbacks,
} from '../src/platforms/telegram/telegram.platform.js';
import { TelegramThrottle } from '../src/platforms/telegram/telegram.throttle.js';
import { WhatsAppContactBook, whatsAppAddressBook } from '../src/platforms/whatsapp/whatsapp.platform.js';

const long = (value: number) => returnBigInt(value);

// ---------- Channels (spec 06b) ----------

test('channels the account owns or administers are listed as kind "channel"; subscriber-only and left ones are not', () => {
  const chats: TelegramChatRecord[] = [
    { kind: 'channel', id: '-1001', title: 'Supergroup', megagroup: true },
    { kind: 'channel', id: '-1002', title: 'Owned channel', broadcast: true, admin: true, memberCount: 250 },
    { kind: 'channel', id: '-1003', title: 'Subscribed only', broadcast: true, admin: false },
    { kind: 'channel', id: '-1004', title: 'Left admin channel', broadcast: true, admin: true, left: true },
    { kind: 'channel', id: '-1002', title: 'Owned channel', broadcast: true, admin: true }, // duplicate page entry
  ];
  assert.deepEqual(selectTelegramGroups(chats), [
    { id: '-1001', title: 'Supergroup' },
    { id: '-1002', title: 'Owned channel', memberCount: 250, kind: 'channel' },
  ]);
});

test('readDialogPage marks creator and admin channels, also when absent fields arrive as null', async () => {
  const photo = new Api.ChatPhotoEmpty();
  const owned = new Api.Channel({ id: long(11), accessHash: long(1), title: 'Owned', broadcast: true, creator: true, photo, date: 1, participantsCount: 40 });
  const adminOf = new Api.Channel({ id: long(12), accessHash: long(2), title: 'Admin of', broadcast: true, photo, date: 1,
    adminRights: new Api.ChatAdminRights({ postMessages: true }) });
  const subscribed = new Api.Channel({ id: long(13), accessHash: long(3), title: 'Subscribed', broadcast: true, photo, date: 1 });
  for (const field of ['creator', 'adminRights', 'left', 'megagroup']) (subscribed as unknown as Record<string, unknown>)[field] = null;
  const dialog = (channelId: number) => new Api.Dialog({ peer: new Api.PeerChannel({ channelId: long(channelId) }), topMessage: 1,
    readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
  const page = new Api.messages.Dialogs({ dialogs: [dialog(11), dialog(12), dialog(13)], messages: [], chats: [owned, adminOf, subscribed], users: [] });
  const { chats } = await readDialogPage({ invoke: async () => page } as never, undefined);
  assert.deepEqual(chats.map(chat => [chat.title, chat.admin, chat.broadcast]), [['Owned', true, true], ['Admin of', true, true], ['Subscribed', false, true]]);
  assert.deepEqual(selectTelegramGroups(chats), [
    { id: '-10011', title: 'Owned', memberCount: 40, kind: 'channel' },
    { id: '-10012', title: 'Admin of', kind: 'channel' },
  ]);
  assert.deepEqual(chats[0]!.ref, { kind: 'channel', channelId: '11', accessHash: '1' }); // fetched like a supergroup
});

// ---------- Phone contacts: Telegram ----------

test('toTelegramAddressBook keeps name, phone, and username, and skips the account itself, deleted accounts, and bots', () => {
  const members: TelegramMember[] = [
    { id: '1', firstName: ' Ali ', lastName: 'Haddad', phone: '9613000000', username: 'ali', contact: true },
    { id: '2', firstName: 'No phone', usernames: [{ username: 'old', active: false }, { username: 'nophone', active: true }] },
    { id: '3', firstName: 'Me', self: true },
    { id: '4', firstName: 'Gone', deleted: true },
    { id: '5', firstName: 'Bot', bot: true },
  ];
  assert.deepEqual(toTelegramAddressBook(members), [
    { id: '1', name: 'Ali Haddad', phoneNumber: '+9613000000', username: 'ali' },
    { id: '2', name: 'No phone', username: 'nophone' },
  ]);
});

class ContactsClient implements TelegramClientAdapter {
  calls = 0;
  fail = false;
  async connect() {}
  loginWithQr(callbacks: TelegramLoginCallbacks) { return callbacks.qrCode(Buffer.from('t')); }
  async getDialogs() { return { chats: [] }; }
  async isChannelHidden() { return false; }
  async getChatMembers() { return { members: [], hidden: false }; }
  async getChannelMembers() { return { members: [], returned: 0, count: 0 }; }
  async getContacts(): Promise<TelegramMember[]> {
    this.calls += 1;
    if (this.fail) throw Object.assign(new Error('FLOOD_WAIT_99 +9613000000'), { errorMessage: 'FLOOD_WAIT_99', seconds: 99 });
    return [{ id: '7', firstName: 'Saved', phone: '9617000000', contact: true }];
  }
  async logOut() {}
  async destroy() {}
}

test('Telegram listAddressBook makes one throttled request, says the file has usernames, and logs failures by code only', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const client = new ContactsClient();
  const platform = new TelegramPlatform({ makeClient: () => client, throttle: new TelegramThrottle({ now: () => 0, sleep: async () => {} }) });
  await assert.rejects(platform.listAddressBook(), /not connected/);
  await platform.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await platform.listAddressBook(), { contacts: [{ id: '7', name: 'Saved', phoneNumber: '+9617000000' }], usernames: true });
  assert.equal(client.calls, 1);
  client.fail = true;
  await assert.rejects(platform.listAddressBook(), /FLOOD_WAIT/);
  assert.doesNotMatch(JSON.stringify(errors.mock.calls.map(call => call.arguments)), /9613000000/);
  await platform.disconnect();
});

// ---------- Phone contacts: WhatsApp ----------

test('whatsAppAddressBook: saved names only, phone from the ID or the LID mapping, name-only when hidden, never the account', async () => {
  const book = new WhatsAppContactBook();
  book.add([
    { id: '961111@s.whatsapp.net', name: 'Ali saved' },
    { id: '961222@s.whatsapp.net', notify: 'Push name only' }, // not saved in the phone
    { id: '5@lid', name: 'Mapped LID' },
    { id: '6@lid', name: 'Hidden number' },
    { id: '999@s.whatsapp.net', name: 'Me' },
    { id: 'team@g.us', name: 'A group' },
    { id: '7@lid', phoneNumber: '961777@s.whatsapp.net', name: 'Both IDs' },
  ]);
  const contacts = await whatsAppAddressBook(book.saved(), ['999@s.whatsapp.net'],
    async lid => (lid === '5@lid' ? '961555@s.whatsapp.net' : undefined));
  assert.deepEqual(contacts, [
    { id: 'pn:961111', name: 'Ali saved', phoneNumber: '+961111' },
    { id: 'pn:961555', name: 'Mapped LID', phoneNumber: '+961555' },
    { id: 'lid:6@lid', name: 'Hidden number' }, // kept as a name-only row (the user, 2026-11-26)
    { id: 'pn:961777', name: 'Both IDs', phoneNumber: '+961777' },
  ]);
});

// ---------- One-sheet workbook ----------

async function workbookOf(write: (out: PassThrough) => Promise<void>) {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', chunk => chunks.push(chunk));
  await write(out);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks));
  return workbook;
}

for (const [usernames, headers] of [[true, ['Name', 'Phone', 'Username']], [false, ['Name', 'Phone']]] as const) {
  test(`address book export: one "Contacts" sheet, deduplicated and sorted, usernames ${usernames ? 'on' : 'off'}`, async () => {
    const book: AddressBook = { usernames, contacts: [
      { id: 'b', name: 'beta', phoneNumber: '+2' },
      { id: 'a', name: 'Alpha', phoneNumber: '+1', username: 'alpha' },
      { id: 'b', name: 'beta again', phoneNumber: '+2' },
      { id: 'c', name: '', phoneNumber: '+3' },
    ] };
    const platform = { listAddressBook: async () => book } as unknown as Platform;
    const service = new ExportService(new ExcelWriter());
    const prepared = await service.prepareAddressBook(platform);
    const workbook = await workbookOf(out => service.writeAddressBook(prepared, out));
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Contacts']);
    const sheet = workbook.getWorksheet('Contacts')!;
    const rows = Array.from({ length: sheet.rowCount }, (_, index) => headers.map((_header, column) => sheet.getRow(index + 1).getCell(column + 1).value ?? ''));
    assert.deepEqual(rows[0], headers);
    assert.deepEqual(rows.slice(1).map(row => row[0]), ['Alpha', 'beta', '']);
    if (usernames) assert.equal(rows[1]![2], '@alpha');
  });
}
