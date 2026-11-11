export type PlatformName = 'telegram' | 'whatsapp';
export type ConnectionStatus = 'waiting-for-scan' | 'connected' | 'disconnected';
export interface PlatformStatus { status: ConnectionStatus; qr?: string }
export interface Group { id: string; title: string }
export interface Contact { id: string; name: string; phoneNumber?: string; username?: string }
export type ContactCategory = 'saved' | 'unsaved_reachable' | 'unsaved_unreachable' | 'unsaved';
export type CategorizedContacts = Array<{ category: ContactCategory; contacts: Contact[] }>;

export interface Platform {
  connect(): Promise<void>;
  getStatus(): Promise<PlatformStatus>;
  listGroups(): Promise<Group[]>;
  listContacts(groupIds: readonly string[]): Promise<CategorizedContacts>;
  disconnect(): Promise<void>;
}

export type PlatformFactory = (name: PlatformName) => Platform;
