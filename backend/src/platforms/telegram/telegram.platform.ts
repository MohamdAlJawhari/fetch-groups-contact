import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { StringSession } from 'telegram/sessions/index.js';
import { getPeerId } from 'telegram/Utils.js';
import type { TelegramCredentials } from '../../config/env.schema.js';
import { PlatformError } from '../platform.errors.js';
import type { CategorizedContacts, Group, Platform, PlatformStatus } from '../platform.types.js';
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
}

/** One `messages.getDialogs` request. `next` is an opaque offset for the following page, absent on the last one. */
export interface TelegramDialogPage { chats: TelegramChatRecord[]; next?: unknown }

/** The small slice of GramJS the platform uses, so the state machine can be tested without a network. */
export interface TelegramClientAdapter {
  connect(): Promise<void>;
  /** Resolves once logged in (after the scan, and the 2FA password if any). */
  loginWithQr(callbacks: TelegramLoginCallbacks): Promise<void>;
  /** Exactly one Telegram request per call, so the platform can throttle every page. */
  getDialogs(offset?: unknown): Promise<TelegramDialogPage>;
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
      return selectTelegramGroups(chats);
    } catch (error) {
      console.error('Telegram listGroups failed', describeTelegramError(error));
      throw error;
    }
  }

  async listContacts(_groupIds: readonly string[]): Promise<CategorizedContacts> {
    throw new Error('Telegram contacts are not implemented yet (T18)');
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
      // Absent optional fields arrive as `null` from Telegram (not `undefined`), so test for a real value.
      migrated: Boolean(chat.migratedTo) && !(chat.migratedTo instanceof Api.InputChannelEmpty) };
  }
  if (chat instanceof Api.Channel) {
    return { kind: 'channel', id: getPeerId(chat), title: chat.title, left: chat.left, megagroup: chat.megagroup };
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
