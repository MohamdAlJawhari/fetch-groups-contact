import makeWASocket, {
  initAuthCreds, jidNormalizedUser, proto,
  type AuthenticationState, type Contact as BaileysContact, type GroupMetadata, type SignalDataTypeMap, type SignalKeyStore,
} from 'baileys';
import { PlatformError } from '../platform.errors.js';
import type { CategorizedContacts, Group, Platform, PlatformStatus } from '../platform.types.js';
import { categorizeWhatsAppMembers, type WhatsAppMember } from './whatsapp.categorizer.js';

// ---------- The slice of Baileys the platform uses (docs/specs/08-whatsapp.md 4.2), so it can be tested offline ----------

/** A contact as Baileys reports it, with JIDs already normalized (no device suffix). */
export interface WhatsAppContactRecord { id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; username?: string }
export interface WhatsAppParticipantRecord { id: string; phoneNumber?: string; lid?: string; username?: string }
export interface WhatsAppGroupRecord { id: string; subject: string; isCommunity?: boolean; participants: WhatsAppParticipantRecord[] }

export interface WhatsAppSocketEvents {
  qr(qr: string): void;
  open(): void;
  /** `code` is WhatsApp's disconnect status (e.g. 515 restart required, 401 logged out). */
  close(code: number | undefined): void;
  contacts(contacts: WhatsAppContactRecord[]): void;
}

export interface WhatsAppSocket {
  /** One request: every group the account is in, with participants. */
  fetchGroups(): Promise<WhatsAppGroupRecord[]>;
  /** Waits for the phone's app-state key, then resyncs only the contacts collection. */
  syncContacts(timeoutMs: number): Promise<void>;
  /** Baileys' local LID→phone mapping; no request. */
  phoneForLid(lid: string): Promise<string | undefined>;
  /** The linked account's own phone JID and LID, normalized. */
  selfIds(): string[];
  logout(): Promise<void>;
  end(): void;
}

/** `createAuth` builds an in-memory auth state; `makeSocket` reuses it, so a 515 restart keeps the link. */
export interface WhatsAppSessionFactory {
  createAuth(): unknown;
  makeSocket(auth: unknown, events: WhatsAppSocketEvents): WhatsAppSocket;
}

export interface WhatsAppPlatformOptions {
  session: WhatsAppSessionFactory;
  now?: () => number;
  /** Spec 4.3: 15 s for the first QR. */
  connectTimeoutMs?: number;
  /** Spec 4.2: 30 s for the phone to share the app-state key. */
  contactsKeyTimeoutMs?: number;
  /** Spec 4.5: how long an export waits for the saved-contacts sync. */
  contactsWaitMs?: number;
  /** Spec 4.7: 5 s for logout. */
  logoutTimeoutMs?: number;
}

const RESTART_REQUIRED = 515;
const MAX_RESTARTS = 3;
const GROUP_CACHE_MS = 60_000;

// ---------- Pure helpers ----------

const PN = /^(\d+)@s\.whatsapp\.net$/;
const isPn = (jid: string | undefined): jid is string => typeof jid === 'string' && PN.test(jid);
const isLid = (jid: string | undefined): jid is string => typeof jid === 'string' && jid.endsWith('@lid');
const pnDigits = (jid: string | undefined) => (jid ? PN.exec(jid)?.[1] : undefined);
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Spec 4.4: community parent entries are not chats; the rest sorted by title. */
export function selectWhatsAppGroups(groups: readonly WhatsAppGroupRecord[]): Group[] {
  return groups.filter(group => !group.isCommunity)
    .map(group => ({ id: group.id, title: group.subject, memberCount: group.participants.length }))
    .sort((a, b) => collator.compare(a.title.trim(), b.title.trim()));
}

/** Merges contact reports; a later report never erases a known field (e.g. a push name keeps the saved name). */
export class WhatsAppContactBook {
  private readonly byJid = new Map<string, WhatsAppContactRecord>();
  add(records: readonly WhatsAppContactRecord[]) {
    for (const record of records) {
      const keys = [record.id, record.lid, record.phoneNumber].filter((key): key is string => Boolean(key));
      const merged: WhatsAppContactRecord = { id: record.id };
      for (const known of keys.map(key => this.byJid.get(key))) if (known) mergeInto(merged, known);
      mergeInto(merged, record);
      for (const key of [merged.id, merged.lid, merged.phoneNumber]) if (key) this.byJid.set(key, merged);
    }
  }
  find(keys: ReadonlyArray<string | undefined>): WhatsAppContactRecord | undefined {
    const found = keys.flatMap(key => (key && this.byJid.get(key) ? [this.byJid.get(key)!] : []));
    if (!found.length) return undefined;
    const merged: WhatsAppContactRecord = { id: found[0]!.id };
    for (const record of found) mergeInto(merged, record);
    return merged;
  }
  clear() { this.byJid.clear(); }
}
function mergeInto(target: WhatsAppContactRecord, source: WhatsAppContactRecord) {
  for (const field of ['lid', 'phoneNumber', 'name', 'notify', 'username'] as const) {
    if (source[field]) target[field] = source[field];
  }
}

/** Spec 4.5 step 3: phone, saved name, push name, username for every participant; the linked account is skipped. */
export async function resolveWhatsAppMembers(
  participants: readonly WhatsAppParticipantRecord[], contacts: WhatsAppContactBook, selfIds: readonly string[],
  phoneForLid: (lid: string) => Promise<string | undefined>,
): Promise<WhatsAppMember[]> {
  const self = new Set(selfIds);
  const members: WhatsAppMember[] = [];
  for (const participant of participants) {
    const lid = [participant.id, participant.lid].find(isLid);
    let pn = [participant.id, participant.phoneNumber].find(isPn);
    if (!pn && lid) { const mapped = await phoneForLid(lid); if (isPn(mapped)) pn = mapped; }
    const contact = contacts.find([pn, lid, participant.id]);
    if (!pn && isPn(contact?.phoneNumber)) pn = contact.phoneNumber;
    if ([participant.id, lid, pn].some(id => id && self.has(id))) continue;
    const digits = pnDigits(pn);
    const member: WhatsAppMember = { id: digits ? `pn:${digits}` : `lid:${lid ?? participant.id}` };
    if (digits) member.phone = digits;
    if (contact?.name) member.savedName = contact.name;
    if (contact?.notify) member.pushName = contact.notify;
    const username = participant.username || contact?.username;
    if (username) member.username = username;
    members.push(member);
  }
  return members;
}

// ---------- Platform ----------

type State = 'idle' | 'waiting' | 'connected' | 'disconnected';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PlatformError('unavailable')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const kind = (error: unknown) => (error instanceof Error ? error.constructor.name : 'unknown');

export class WhatsAppPlatform implements Platform {
  private state: State = 'idle';
  private auth: unknown;
  private socket: WhatsAppSocket | undefined;
  /** Events from an older socket (before a 515 restart, or after disconnect) are ignored. */
  private generation = 0;
  private restarts = 0;
  private qr: string | undefined;
  private firstQr: { resolve(): void; reject(error: Error): void } | undefined;
  private readonly contacts = new WhatsAppContactBook();
  private contactsSync: Promise<void> | undefined;
  private contactsSynced = false;
  private groupCache: { at: number; groups: WhatsAppGroupRecord[] } | undefined;
  private readonly now: () => number;

  constructor(private readonly options: WhatsAppPlatformOptions) {
    this.now = options.now ?? Date.now;
  }

  async connect() {
    if (this.state !== 'idle') throw new Error('WhatsApp platform already started');
    this.state = 'waiting';
    this.auth = this.options.session.createAuth();
    const firstQr = new Promise<void>((resolve, reject) => { this.firstQr = { resolve, reject }; });
    firstQr.catch(() => {});
    this.openSocket();
    try {
      await withTimeout(firstQr, this.options.connectTimeoutMs ?? 15_000);
    } catch {
      await this.disconnect();
      throw new PlatformError('unavailable');
    }
  }

  private openSocket() {
    const generation = ++this.generation;
    const live = () => generation === this.generation && this.state !== 'disconnected';
    this.socket = this.options.session.makeSocket(this.auth, {
      qr: (qr) => {
        if (!live() || this.state !== 'waiting') return;
        this.qr = qr;
        this.firstQr?.resolve();
      },
      open: () => {
        if (!live()) return;
        this.state = 'connected';
        this.qr = undefined;
        void this.ensureContactsSync().catch(() => {});
      },
      close: (code) => {
        if (!live()) return;
        if (code === RESTART_REQUIRED && this.restarts < MAX_RESTARTS) {
          // WhatsApp closes once right after the scan; reconnect with the same in-memory auth state.
          this.restarts += 1;
          this.qr = undefined;
          this.openSocket();
          return;
        }
        console.error('WhatsApp connection closed', { code: typeof code === 'number' ? code : undefined });
        this.firstQr?.reject(new PlatformError('unavailable'));
        void this.disconnect();
      },
      contacts: (records) => { if (live()) this.contacts.add(records); },
    });
  }

  /** One sync at a time; a failed sync is forgotten so the next export retries it. */
  private ensureContactsSync() {
    if (this.contactsSynced) return Promise.resolve();
    const socket = this.socket;
    if (!socket) return Promise.reject(new PlatformError('unavailable'));
    this.contactsSync ??= socket.syncContacts(this.options.contactsKeyTimeoutMs ?? 30_000).then(
      () => { this.contactsSynced = true; },
      (error: unknown) => {
        console.error('WhatsApp contacts sync failed', { kind: kind(error) });
        this.contactsSync = undefined;
        throw new PlatformError('unavailable');
      },
    );
    return this.contactsSync;
  }

  async getStatus(): Promise<PlatformStatus> {
    switch (this.state) {
      case 'waiting': return this.qr ? { status: 'waiting-for-scan', qr: this.qr } : { status: 'waiting-for-scan' };
      case 'connected': return { status: 'connected' };
      default: return { status: 'disconnected' };
    }
  }

  private connectedSocket() {
    if (this.state !== 'connected' || !this.socket) throw new Error('WhatsApp platform is not connected');
    return this.socket;
  }

  private async fetchGroups(socket: WhatsAppSocket) {
    try {
      const groups = await socket.fetchGroups();
      this.groupCache = { at: this.now(), groups };
      return groups;
    } catch (error) {
      console.error('WhatsApp listGroups failed', { kind: kind(error) });
      throw error;
    }
  }

  async listGroups(): Promise<Group[]> {
    return selectWhatsAppGroups(await this.fetchGroups(this.connectedSocket()));
  }

  async listContacts(groupIds: readonly string[]): Promise<CategorizedContacts> {
    const socket = this.connectedSocket();
    const sync = this.ensureContactsSync();
    try {
      await withTimeout(sync, this.options.contactsWaitMs ?? 60_000);
    } catch (error) {
      // A sync that hangs must not block every later export: forget it so the next call starts a fresh one.
      if (this.contactsSync === sync) this.contactsSync = undefined;
      throw error instanceof PlatformError ? error : new PlatformError('unavailable');
    }
    const cached = this.groupCache && this.now() - this.groupCache.at <= GROUP_CACHE_MS ? this.groupCache.groups : undefined;
    const groups = new Map((cached ?? await this.fetchGroups(socket)).map(group => [group.id, group]));
    const participants = groupIds.flatMap(id => {
      const group = groups.get(id);
      if (!group || group.isCommunity) throw new Error('Unknown WhatsApp group');
      return group.participants;
    });
    const members = await resolveWhatsAppMembers(participants, this.contacts, socket.selfIds(), lid => socket.phoneForLid(lid));
    return categorizeWhatsAppMembers(members);
  }

  async disconnect() {
    const socket = this.socket;
    const linked = this.state === 'connected';
    this.socket = undefined;
    this.state = 'disconnected';
    this.generation += 1;
    this.qr = undefined;
    this.auth = undefined;
    this.contacts.clear();
    this.groupCache = undefined;
    this.firstQr?.reject(new PlatformError('unavailable'));
    if (!socket) return;
    if (linked) {
      try { await withTimeout(socket.logout(), this.options.logoutTimeoutMs ?? 5_000); }
      catch (error) { console.error('WhatsApp logout failed', { kind: kind(error) }); }
    }
    try { socket.end(); } catch (error) { console.error('WhatsApp socket cleanup failed', { kind: kind(error) }); }
  }
}

// ---------- Real Baileys sessions ----------

/** Baileys requires a logger; this one discards everything (spec 4.8: nothing it would log is safe). */
const silentLogger = {
  level: 'silent',
  child() { return silentLogger; },
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

interface MemoryAuth { state: AuthenticationState }

/** In-memory auth state: creds plus a Map key store. Nothing touches the disk (spec 4.2). */
function createMemoryAuth(): MemoryAuth {
  const store = new Map<string, Map<string, unknown>>();
  const keys: SignalKeyStore = {
    async get(type, ids) {
      const bucket = store.get(type);
      const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
      for (const id of ids) {
        let value = bucket?.get(id);
        if (value && type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
        if (value !== undefined) result[id] = value as SignalDataTypeMap[typeof type];
      }
      return result;
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        let bucket = store.get(type);
        if (!bucket) store.set(type, bucket = new Map());
        for (const [id, value] of Object.entries(entries ?? {})) {
          if (value) bucket.set(id, value); else bucket.delete(id);
        }
      }
    },
    async clear() { store.clear(); },
  };
  return { state: { creds: initAuthCreds(), keys } };
}

const normalized = (jid: string | undefined | null) => (jid ? jidNormalizedUser(jid) : undefined);

function toContactRecord(contact: Partial<BaileysContact>): WhatsAppContactRecord | undefined {
  const id = normalized(contact.id);
  if (!id) return undefined;
  const record: WhatsAppContactRecord = { id };
  const lid = normalized(contact.lid);
  const phoneNumber = normalized(contact.phoneNumber);
  if (lid) record.lid = lid;
  if (phoneNumber) record.phoneNumber = phoneNumber;
  if (contact.name) record.name = contact.name;
  if (contact.notify) record.notify = contact.notify;
  if (contact.username) record.username = contact.username;
  return record;
}
const toContactRecords = (contacts: ReadonlyArray<Partial<BaileysContact>> | undefined) =>
  (contacts ?? []).flatMap(contact => { const record = toContactRecord(contact); return record ? [record] : []; });

export function toGroupRecord(group: GroupMetadata): WhatsAppGroupRecord {
  return {
    id: group.id,
    subject: group.subject ?? '',
    isCommunity: Boolean(group.isCommunity),
    participants: group.participants.flatMap(participant => {
      const id = normalized(participant.id);
      if (!id) return [];
      const record: WhatsAppParticipantRecord = { id };
      const phoneNumber = normalized(participant.phoneNumber);
      const lid = normalized(participant.lid);
      if (phoneNumber) record.phoneNumber = phoneNumber;
      if (lid) record.lid = lid;
      if (participant.username) record.username = participant.username;
      return [record];
    }),
  };
}

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new PlatformError('unavailable');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export function baileysSessionFactory(): WhatsAppSessionFactory {
  return {
    createAuth: () => createMemoryAuth(),
    makeSocket(auth, events) {
      const { state } = auth as MemoryAuth;
      const sock = makeWASocket({
        auth: state,
        logger: silentLogger,
        browser: ['Contact Export Tool', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Only push names (people's own display names); no chat history is downloaded (spec 4.2).
        shouldSyncHistoryMessage: message => message.syncType === proto.HistorySync.HistorySyncType.PUSH_NAME,
        generateHighQualityLinkPreview: false,
      });
      sock.ev.on('connection.update', (update) => {
        if (update.qr) events.qr(update.qr);
        if (update.connection === 'open') events.open();
        if (update.connection === 'close') {
          const code = (update.lastDisconnect?.error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
          events.close(typeof code === 'number' ? code : undefined);
        }
      });
      sock.ev.on('contacts.upsert', contacts => events.contacts(toContactRecords(contacts)));
      sock.ev.on('contacts.update', contacts => events.contacts(toContactRecords(contacts)));
      sock.ev.on('messaging-history.set', ({ contacts }) => events.contacts(toContactRecords(contacts)));
      return {
        async fetchGroups() { return Object.values(await sock.groupFetchAllParticipating()).map(toGroupRecord); },
        async syncContacts(timeoutMs) {
          await waitUntil(() => Boolean(state.creds.myAppStateKeyId), timeoutMs);
          await sock.resyncAppState(['critical_unblock_low'], true);
        },
        async phoneForLid(lid) { return normalized(await sock.signalRepository.lidMapping.getPNForLID(lid)); },
        selfIds() { return [state.creds.me?.id, state.creds.me?.lid].flatMap(jid => { const id = normalized(jid); return id ? [id] : []; }); },
        async logout() { await sock.logout(); },
        end() { void sock.end(undefined); },
      };
    },
  };
}
