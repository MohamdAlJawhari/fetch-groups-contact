import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { StringSession } from 'telegram/sessions/index.js';
import { getPeerId } from 'telegram/Utils.js';
import type { TelegramCredentials } from '../../config/env.schema.js';
import { PlatformError } from '../platform.errors.js';
import type { CategorizedContacts, Group, Platform, PlatformStatus } from '../platform.types.js';
import { categorizeTelegramMembers, type TelegramMember } from './telegram.categorizer.js';
import { TelegramThrottle } from './telegram.throttle.js';

/** The GramJS login callbacks the platform hands to the client (docs/specs/06-telegram.md 4.3). */
export interface TelegramLoginCallbacks {
  qrCode(token: Buffer): Promise<void>;
  password(hint?: string): Promise<string>;
  /** Called for errors in GramJS's password loop. Returning true stops the login. */
  onError(error: Error): Promise<boolean>;
}

/** A chat from the dialog list, copied out of GramJS objects (spec 06, 4.4). */
export interface TelegramChatRecord {
  /** `chat` = basic group, `channel` = supergroup or broadcast channel, `unavailable` = forbidden or empty. */
  kind: 'chat' | 'channel' | 'unavailable';
  /** GramJS's marked peer ID: `-123` for basic groups, `-100123` for channels and supergroups. */
  id: string;
  title: string;
  left?: boolean;
  deactivated?: boolean;
  migrated?: boolean;
  megagroup?: boolean;
  /** What member requests need: the raw chat or channel ID, and the channel access hash. */
  ref?: TelegramGroupRef;
}

/** How to address a group in member requests. IDs and hashes are decimal strings (no bigint in our code). */
export type TelegramGroupRef =
  | { kind: 'chat'; chatId: string }
  | { kind: 'channel'; channelId: string; accessHash: string };

/** One `channels.getParticipants` page: the members on it, how many participants it held, and Telegram's total. */
export interface TelegramMemberPage { members: TelegramMember[]; returned: number; count: number }

/** One `messages.getDialogs` request. `next` is an opaque offset for the following page, absent on the last one. */
export interface TelegramDialogPage { chats: TelegramChatRecord[]; next?: unknown }

/** The small slice of GramJS the platform uses, so the state machine can be tested without a network. */
export interface TelegramClientAdapter {
  connect(): Promise<void>;
  /** Resolves once logged in (after the scan, and the 2FA password if any). */
  loginWithQr(callbacks: TelegramLoginCallbacks): Promise<void>;
  /** Exactly one Telegram request per call, so the platform can throttle every page. */
  getDialogs(offset?: unknown): Promise<TelegramDialogPage>;
  /** `channels.getFullChannel`: true when this account may not see the supergroup's members (spec 4.5 step 1). */
  isChannelHidden(ref: Extract<TelegramGroupRef, { kind: 'channel' }>): Promise<boolean>;
  /** `messages.getFullChat`: every member of a basic group; `hidden` when Telegram withholds the list. */
  getChatMembers(ref: Extract<TelegramGroupRef, { kind: 'chat' }>): Promise<{ members: TelegramMember[]; hidden: boolean }>;
  /** `channels.getParticipants` (recent filter), up to 200 from `offset`. */
  getChannelMembers(ref: Extract<TelegramGroupRef, { kind: 'channel' }>, offset: number): Promise<TelegramMemberPage>;
  logOut(): Promise<void>;
  destroy(): Promise<void>;
}

export type TelegramClientMaker = () => TelegramClientAdapter;

export interface TelegramPlatformOptions {
  makeClient: TelegramClientMaker;
  /** How long connect() waits for the first QR token (spec 4.3: 10 s). */
  connectTimeoutMs?: number;
  /** How long submitPassword() waits for Telegram's answer; covers GramJS's own flood sleep of up to 30 s. */
  passwordTimeoutMs?: number;
  /** Timeout for auth.logOut and for destroying the client (spec 4.8: 5 s). */
  logoutTimeoutMs?: number;
  /** Tests pass a throttle with a fake clock. */
  throttle?: TelegramThrottle;
}

/** Safety cap on dialog pages (100 dialogs each), so a paging bug cannot loop forever. */
const MAX_DIALOG_PAGES = 100;
/** Telegram stops returning supergroup members at about 10k (spec 4.5); 60 pages of 200 leaves headroom. */
const MAX_MEMBER_PAGES = 60;
const isAdminRequired = (error: unknown) => (error as { errorMessage?: unknown } | null)?.errorMessage === 'CHAT_ADMIN_REQUIRED';

/**
 * Pure filter (spec 4.4): basic groups and supergroups the user is still in, once each, in dialog order.
 * Broadcast channels, migrated or deactivated groups, left groups, and forbidden chats are dropped.
 */
export function selectTelegramGroups(chats: readonly TelegramChatRecord[]): Group[] {
  const seen = new Set<string>();
  const groups: Group[] = [];
  for (const chat of chats) {
    const keep = chat.kind === 'chat' ? !chat.left && !chat.deactivated && !chat.migrated
      : chat.kind === 'channel' ? chat.megagroup === true && !chat.left
      : false;
    if (!keep || seen.has(chat.id)) continue;
    seen.add(chat.id);
    groups.push({ id: chat.id, title: chat.title });
  }
  return groups;
}

type State = 'idle' | 'waiting' | 'password' | 'connected' | 'disconnected';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // A deferred nobody awaits must not become an unhandled rejection.
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PlatformError('unavailable')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Only the error class and Telegram's constant error code (e.g. FLOOD_WAIT). Never messages: they can echo request data. */
export function describeTelegramError(error: unknown) {
  const code = (error as { errorMessage?: unknown } | null)?.errorMessage;
  const seconds = (error as { seconds?: unknown } | null)?.seconds;
  return {
    kind: error instanceof Error ? error.constructor.name : 'unknown',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined,
    seconds: typeof seconds === 'number' ? seconds : undefined,
  };
}

const isWrongPassword = (error: unknown) => (error as { errorMessage?: unknown } | null)?.errorMessage === 'PASSWORD_HASH_INVALID';

export class TelegramPlatform implements Platform {
  private state: State = 'idle';
  private client: TelegramClientAdapter | undefined;
  private qr: string | undefined;
  private passwordHint: string | undefined;
  /** Resolved with the password when GramJS is waiting for one. */
  private passwordRequest: Deferred<string> | undefined;
  /** Waiters for the next password request (GramJS asks again shortly after a wrong password). */
  private passwordRequestWaiters: Array<() => void> = [];
  /** The submitPassword call waiting for Telegram's answer. */
  private submission: Deferred<void> | undefined;
  private cancelled = false;
  private readonly connectTimeoutMs: number;
  private readonly passwordTimeoutMs: number;
  private readonly logoutTimeoutMs: number;
  private readonly throttle: TelegramThrottle;
  /** Filled by listGroups; export validation always lists groups right before listContacts. */
  private groupRefs = new Map<string, TelegramGroupRef>();

  constructor(private readonly options: TelegramPlatformOptions) {
    this.throttle = options.throttle ?? new TelegramThrottle();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.passwordTimeoutMs = options.passwordTimeoutMs ?? 45_000;
    this.logoutTimeoutMs = options.logoutTimeoutMs ?? 5_000;
  }

  async connect() {
    if (this.state !== 'idle') throw new Error('Telegram platform already started');
    const client = this.options.makeClient();
    this.client = client;
    this.state = 'waiting';
    const firstQr = deferred<void>();
    const callbacks: TelegramLoginCallbacks = {
      qrCode: async (token) => {
        if (this.cancelled) throw new Error('Login cancelled');
        this.qr = `tg://login?token=${token.toString('base64url')}`;
        firstQr.resolve();
      },
      password: (hint) => {
        if (this.cancelled) return Promise.reject(new Error('Login cancelled'));
        this.state = 'password';
        this.qr = undefined;
        this.passwordHint = hint ? hint : undefined;
        this.passwordRequest = deferred<string>();
        for (const wake of this.passwordRequestWaiters.splice(0)) wake();
        return this.passwordRequest.promise;
      },
      onError: async (error) => {
        if (this.cancelled) return true;
        const submission = this.submission;
        this.submission = undefined;
        // An error that wasn't caused by a submitted password (e.g. account.getPassword failing) would make
        // GramJS loop straight back into the same request, so stop the login instead of retrying.
        if (!submission) return true;
        if (!isWrongPassword(error)) console.error('Telegram password check failed', describeTelegramError(error));
        submission.reject(new PlatformError(isWrongPassword(error) ? 'wrong_password' : 'unavailable'));
        return false;
      },
    };
    void (async () => {
      await client.connect();
      await client.loginWithQr(callbacks);
    })().then(
      () => {
        if (this.cancelled) return;
        this.state = 'connected';
        this.qr = undefined;
        this.passwordHint = undefined;
        this.submission?.resolve();
        this.submission = undefined;
      },
      (error: unknown) => {
        firstQr.reject(new PlatformError('unavailable'));
        if (this.cancelled) return;
        console.error('Telegram login failed', describeTelegramError(error));
        void this.disconnect();
      },
    );
    try {
      await withTimeout(firstQr.promise, this.connectTimeoutMs);
    } catch {
      await this.disconnect();
      throw new PlatformError('unavailable');
    }
  }

  async getStatus(): Promise<PlatformStatus> {
    switch (this.state) {
      case 'waiting': return this.qr ? { status: 'waiting-for-scan', qr: this.qr } : { status: 'waiting-for-scan' };
      case 'password': return this.passwordHint ? { status: 'password-required', passwordHint: this.passwordHint } : { status: 'password-required' };
      case 'connected': return { status: 'connected' };
      default: return { status: 'disconnected' };
    }
  }

  async submitPassword(password: string) {
    if (this.state !== 'password' || this.submission) throw new Error('Telegram platform is not waiting for a password');
    const submission = deferred<void>();
    this.submission = submission;
    try {
      await withTimeout((async () => {
        // After a wrong password GramJS re-reads the password settings before asking again.
        while (!this.passwordRequest) {
          await new Promise<void>(resolve => this.passwordRequestWaiters.push(resolve));
          if (this.state !== 'password') throw new PlatformError('unavailable');
        }
        const request = this.passwordRequest;
        this.passwordRequest = undefined;
        request.resolve(password);
        await submission.promise;
      })(), this.passwordTimeoutMs);
    } catch (error) {
      if (this.submission === submission) this.submission = undefined;
      throw error instanceof PlatformError ? error : new PlatformError('unavailable');
    }
  }

  async listGroups(): Promise<Group[]> {
    const client = this.client;
    if (this.state !== 'connected' || !client) throw new Error('Telegram platform is not connected');
    try {
      const chats: TelegramChatRecord[] = [];
      let offset: unknown;
      for (let page = 0; page < MAX_DIALOG_PAGES; page++) {
        const result = await this.throttle.run(() => client.getDialogs(offset));
        chats.push(...result.chats);
        if (result.next === undefined) break;
        offset = result.next;
      }
      const groups = selectTelegramGroups(chats);
      const kept = new Set(groups.map(group => group.id));
      this.groupRefs = new Map(chats.flatMap(chat => (kept.has(chat.id) && chat.ref ? [[chat.id, chat.ref] as const] : [])));
      return groups.filter(group => this.groupRefs.has(group.id));
    } catch (error) {
      console.error('Telegram listGroups failed', describeTelegramError(error));
      throw error;
    }
  }

  /** docs/specs/06-telegram.md 4.5: hidden-member check for every group first, then members, one group at a time. */
  async listContacts(groupIds: readonly string[]): Promise<CategorizedContacts> {
    const client = this.client;
    if (this.state !== 'connected' || !client) throw new Error('Telegram platform is not connected');
    if (groupIds.some(id => !this.groupRefs.has(id))) await this.listGroups();
    const refs = groupIds.map(id => {
      const ref = this.groupRefs.get(id);
      if (!ref) throw new Error('Unknown Telegram group');
      return { id, ref };
    });
    try {
      const hidden: string[] = [];
      for (const { id, ref } of refs) {
        if (ref.kind !== 'channel') continue;
        try { if (await this.throttle.run(() => client.isChannelHidden(ref))) hidden.push(id); }
        catch (error) { if (isAdminRequired(error)) hidden.push(id); else throw error; }
      }
      if (hidden.length) throw new PlatformError('members_hidden', hidden);
      const members: TelegramMember[] = [];
      for (const { id, ref } of refs) {
        try {
          if (ref.kind === 'chat') {
            const result = await this.throttle.run(() => client.getChatMembers(ref));
            if (result.hidden) throw new PlatformError('members_hidden', [id]);
            members.push(...result.members);
            continue;
          }
          let offset = 0;
          for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
            const result = await this.throttle.run(() => client.getChannelMembers(ref, offset));
            members.push(...result.members);
            offset += result.returned;
            if (result.returned === 0 || offset >= result.count) break;
          }
        } catch (error) {
          if (isAdminRequired(error)) throw new PlatformError('members_hidden', [id]);
          throw error;
        }
      }
      return categorizeTelegramMembers(members);
    } catch (error) {
      if (!(error instanceof PlatformError && error.code === 'members_hidden')) {
        console.error('Telegram listContacts failed', describeTelegramError(error));
      }
      throw error;
    }
  }

  async disconnect() {
    const client = this.client;
    const wasLoggedIn = this.state === 'connected';
    this.client = undefined;
    this.cancelled = true;
    this.state = 'disconnected';
    this.qr = undefined;
    this.passwordHint = undefined;
    this.passwordRequest?.reject(new Error('Login cancelled'));
    this.passwordRequest = undefined;
    this.submission?.reject(new PlatformError('unavailable'));
    this.submission = undefined;
    for (const wake of this.passwordRequestWaiters.splice(0)) wake();
    if (!client) return;
    if (wasLoggedIn) {
      try { await withTimeout(client.logOut(), this.logoutTimeoutMs); }
      catch (error) { console.error('Telegram logout failed', describeTelegramError(error)); }
    }
    try { await withTimeout(client.destroy(), this.logoutTimeoutMs); }
    catch (error) { console.error('Telegram client cleanup failed', describeTelegramError(error)); }
  }
}

/** Builds real GramJS clients. The session is an in-memory StringSession that is never saved (spec 4.2). */
export function gramJsClientMaker(credentials: TelegramCredentials): TelegramClientMaker {
  return () => {
    const client = new TelegramClient(new StringSession(''), credentials.apiId, credentials.apiHash, {
      connectionRetries: 3,
      requestRetries: 2,
      floodSleepThreshold: 30,
      deviceModel: 'Contact Export Tool',
      systemVersion: 'Server',
      appVersion: '0.1.0',
      langCode: 'en',
      baseLogger: new Logger(LogLevel.NONE),
    });
    return {
      async connect() { await client.connect(); },
      async loginWithQr(callbacks) {
        await client.signInUserWithQrCode({ apiId: credentials.apiId, apiHash: credentials.apiHash }, {
          qrCode: ({ token }) => callbacks.qrCode(token),
          password: (hint) => callbacks.password(hint),
          onError: (error) => callbacks.onError(error),
        });
      },
      async getDialogs(offset) { return readDialogPage(client, offset as DialogOffset | undefined); },
      async isChannelHidden(ref) {
        return isChannelHidden(await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel(ref) })));
      },
      async getChatMembers(ref) {
        return readChatMembers(await client.invoke(new Api.messages.GetFullChat({ chatId: returnBigInt(ref.chatId) })));
      },
      async getChannelMembers(ref, offset) {
        return readChannelMembers(await client.invoke(new Api.channels.GetParticipants({
          channel: inputChannel(ref), filter: new Api.ChannelParticipantsRecent(), offset, limit: MEMBER_PAGE_SIZE, hash: returnBigInt(0),
        })));
      },
      async logOut() { await client.invoke(new Api.auth.LogOut()); },
      async destroy() { await client.destroy(); },
    };
  };
}

const DIALOG_PAGE_SIZE = 100;
interface DialogOffset { date: number; id: number; peer: Api.TypeEntityLike }

function toChatRecord(chat: Api.TypeChat): TelegramChatRecord {
  if (chat instanceof Api.Chat) {
    return { kind: 'chat', id: getPeerId(chat), title: chat.title, left: chat.left, deactivated: chat.deactivated,
      ref: { kind: 'chat', chatId: chat.id.toString() },
      // Absent optional fields arrive as `null` from Telegram (not `undefined`), so test for a real value.
      migrated: Boolean(chat.migratedTo) && !(chat.migratedTo instanceof Api.InputChannelEmpty) };
  }
  if (chat instanceof Api.Channel) {
    return { kind: 'channel', id: getPeerId(chat), title: chat.title, left: chat.left, megagroup: chat.megagroup,
      // A `min` channel object can lack its access hash; without one it can't be queried, so it gets no ref.
      ref: chat.accessHash ? { kind: 'channel', channelId: chat.id.toString(), accessHash: chat.accessHash.toString() } : undefined };
  }
  return { kind: 'unavailable', id: '', title: '' };
}

/**
 * One raw `messages.getDialogs` page. GramJS's own dialog iterator is avoided on purpose: it pages without our
 * throttle, and on a parsing error it prints whole message objects to the console (privacy, spec 4.9).
 * The next offset follows GramJS's iterator: the last dialog's top message date and id, and its peer.
 */
export async function readDialogPage(client: Pick<TelegramClient, 'invoke'>, offset: DialogOffset | undefined): Promise<TelegramDialogPage> {
  const result = await client.invoke(new Api.messages.GetDialogs({
    offsetDate: offset?.date ?? 0,
    offsetId: offset?.id ?? 0,
    offsetPeer: offset?.peer ?? new Api.InputPeerEmpty(),
    limit: DIALOG_PAGE_SIZE,
    hash: returnBigInt(0),
    excludePinned: offset !== undefined, // pinned dialogs come only on the first page
  }));
  if (result instanceof Api.messages.DialogsNotModified) return { chats: [] };
  const chatEntities = new Map<string, Api.TypeChat>();
  for (const chat of result.chats) if (!(chat instanceof Api.ChatEmpty)) chatEntities.set(getPeerId(chat), chat);
  const entities = new Map<string, Api.TypeUser | Api.TypeChat>(chatEntities);
  for (const user of result.users) if (!(user instanceof Api.UserEmpty)) entities.set(getPeerId(user), user);
  const dialogs = result.dialogs.filter((dialog): dialog is Api.Dialog => dialog instanceof Api.Dialog);
  const chats: TelegramChatRecord[] = [];
  for (const dialog of dialogs) {
    if (!(dialog.peer instanceof Api.PeerChat || dialog.peer instanceof Api.PeerChannel)) continue;
    const chat = chatEntities.get(getPeerId(dialog.peer));
    if (chat) chats.push(toChatRecord(chat));
  }
  if (!(result instanceof Api.messages.DialogsSlice) || result.dialogs.length < DIALOG_PAGE_SIZE) return { chats };
  const messages = new Map<string, Api.Message | Api.MessageService>();
  for (const message of result.messages) {
    if (message instanceof Api.Message || message instanceof Api.MessageService) messages.set(`${getPeerId(message.peerId)}:${message.id}`, message);
  }
  let last: Api.Message | Api.MessageService | undefined;
  for (const dialog of [...dialogs].reverse()) {
    last = messages.get(`${getPeerId(dialog.peer)}:${dialog.topMessage}`);
    if (last) break;
  }
  const lastDialog = dialogs.at(-1);
  const lastPeer = lastDialog ? entities.get(getPeerId(lastDialog.peer)) : undefined;
  if (!last || !lastPeer) return { chats }; // no safe offset: stop rather than loop
  return { chats, next: { date: last.date, id: last.id, peer: lastPeer } satisfies DialogOffset };
}

const MEMBER_PAGE_SIZE = 200;

function inputChannel(ref: Extract<TelegramGroupRef, { kind: 'channel' }>) {
  return new Api.InputChannel({ channelId: returnBigInt(ref.channelId), accessHash: returnBigInt(ref.accessHash) });
}

/** Copies only the fields the categorizer needs. Absent fields arrive as null; the categorizer accepts that. */
export function toTelegramMember(user: Api.TypeUser): TelegramMember | undefined {
  if (!(user instanceof Api.User)) return undefined;
  return {
    id: user.id.toString(), firstName: user.firstName, lastName: user.lastName, phone: user.phone, username: user.username,
    usernames: user.usernames?.map(entry => ({ username: entry.username, active: entry.active })) ?? null,
    contact: user.contact, self: user.self, deleted: user.deleted, bot: user.bot,
  };
}

/** Members only: the users list of these responses also carries inviters and other referenced people. */
function membersOf(users: readonly Api.TypeUser[], memberIds: ReadonlySet<string>) {
  return users.flatMap(user => {
    const member = memberIds.has(user.id.toString()) ? toTelegramMember(user) : undefined;
    return member ? [member] : [];
  });
}

/** Hidden when Telegram says this account can't view the list, or hides it from non-admins and we aren't one. */
export function isChannelHidden(result: Api.messages.ChatFull): boolean {
  const full = result.fullChat;
  if (!(full instanceof Api.ChannelFull)) return true;
  const channel = result.chats.find((chat): chat is Api.Channel => chat instanceof Api.Channel && chat.id.toString() === full.id.toString());
  const admin = Boolean(channel?.creator || channel?.adminRights);
  return !full.canViewParticipants || (Boolean(full.participantsHidden) && !admin);
}

export function readChatMembers(result: Api.messages.ChatFull): { members: TelegramMember[]; hidden: boolean } {
  const full = result.fullChat;
  if (!(full instanceof Api.ChatFull) || !(full.participants instanceof Api.ChatParticipants)) return { members: [], hidden: true };
  const ids = new Set(full.participants.participants.map(participant => participant.userId.toString()));
  return { members: membersOf(result.users, ids), hidden: false };
}

export function readChannelMembers(result: Api.channels.TypeChannelParticipants): TelegramMemberPage {
  if (!(result instanceof Api.channels.ChannelParticipants)) return { members: [], returned: 0, count: 0 };
  const ids = new Set(result.participants.flatMap(participant => {
    if ('userId' in participant) return [participant.userId.toString()];
    return participant.peer instanceof Api.PeerUser ? [participant.peer.userId.toString()] : [];
  }));
  return { members: membersOf(result.users, ids), returned: result.participants.length, count: result.count };
}
