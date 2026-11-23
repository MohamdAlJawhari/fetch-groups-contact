import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import type { TelegramCredentials } from '../../config/env.schema.js';
import { PlatformError } from '../platform.errors.js';
import type { CategorizedContacts, Group, Platform, PlatformStatus } from '../platform.types.js';

/** The GramJS login callbacks the platform hands to the client (docs/specs/06-telegram.md 4.3). */
export interface TelegramLoginCallbacks {
  qrCode(token: Buffer): Promise<void>;
  password(hint?: string): Promise<string>;
  /** Called for errors in GramJS's password loop. Returning true stops the login. */
  onError(error: Error): Promise<boolean>;
}

/** The small slice of GramJS the platform uses, so the state machine can be tested without a network. */
export interface TelegramClientAdapter {
  connect(): Promise<void>;
  /** Resolves once logged in (after the scan, and the 2FA password if any). */
  loginWithQr(callbacks: TelegramLoginCallbacks): Promise<void>;
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

  constructor(private readonly options: TelegramPlatformOptions) {
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
    throw new Error('Telegram groups are not implemented yet (T17)');
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
      async logOut() { await client.invoke(new Api.auth.LogOut()); },
      async destroy() { await client.destroy(); },
    };
  };
}
