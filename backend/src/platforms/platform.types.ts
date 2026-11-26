export type PlatformName = 'telegram' | 'whatsapp';
export type ConnectionStatus = 'waiting-for-scan' | 'password-required' | 'connected' | 'disconnected';
/** `qr` only while waiting for a scan; `passwordHint` only while a 2FA password is required (and one is set). */
export interface PlatformStatus { status: ConnectionStatus; qr?: string; passwordHint?: string }
/**
 * `memberCount` only when the platform reports it without extra requests (it includes the account itself).
 * `kind: 'channel'` marks a broadcast channel the account owns or administers (spec 06b); groups have no `kind`.
 */
export interface Group { id: string; title: string; memberCount?: number; kind?: 'channel' }
export interface Contact { id: string; name: string; phoneNumber?: string; username?: string }
/** `address_book` is the one sheet of the phone contacts export (spec 09). */
export type ContactCategory = 'saved' | 'unsaved_reachable' | 'unsaved_unreachable' | 'unsaved' | 'address_book';
export type CategorizedContacts = Array<{ category: ContactCategory; contacts: Contact[] }>;
/** Spec 09: the scanned account's saved contacts. `usernames` says whether the file gets a Username column. */
export interface AddressBook { contacts: Contact[]; usernames: boolean }

export interface Platform {
  connect(): Promise<void>;
  getStatus(): Promise<PlatformStatus>;
  listGroups(): Promise<Group[]>;
  listContacts(groupIds: readonly string[]): Promise<CategorizedContacts>;
  /** Spec 09: the account's saved contacts (only people who use this platform). */
  listAddressBook(): Promise<AddressBook>;
  /** Only for platforms with a password step (Telegram 2FA). Throws PlatformError('wrong_password') on a wrong one. */
  submitPassword?(password: string): Promise<void>;
  /** Idempotent; logs out of the platform when logged in. */
  disconnect(): Promise<void>;
}

export type PlatformFactory = (name: PlatformName) => Platform;
