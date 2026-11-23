import { randomBytes } from 'node:crypto';
import type { Platform, PlatformName } from '../../platforms/platform.types.js';

export interface ConnectionEntry {
  readonly id: string;
  readonly ownerId: string;
  readonly platformName: PlatformName;
  readonly platform: Platform;
  lastActivity: number;
  /** True while an export runs; the reaper skips the connection and a second export gets 409. */
  exporting: boolean;
  /** Set while an export streams; ending the connection calls it to cut the download off. */
  abortExport?: () => void;
  /** Wrong 2FA passwords so far; the 5th ends the connection (docs/specs/06-telegram.md 3.3). */
  wrongPasswords: number;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionEntry>();
  private readonly owners = new Map<string, string>();
  constructor(private readonly now: () => number = Date.now) {}
  add(ownerId: string, platformName: PlatformName, platform: Platform) {
    if (this.owners.has(ownerId)) throw new Error('User already has a connection');
    const id = randomBytes(32).toString('hex');
    const entry: ConnectionEntry = { id, ownerId, platformName, platform, lastActivity: this.now(), exporting: false, wrongPasswords: 0 };
    this.connections.set(id, entry);
    this.owners.set(ownerId, id);
    return entry;
  }
  get(id: string) { return this.connections.get(id); }
  getByOwner(ownerId: string) {
    const id = this.owners.get(ownerId);
    return id ? this.connections.get(id) : undefined;
  }
  touch(id: string) {
    const entry = this.connections.get(id);
    if (entry) entry.lastActivity = this.now();
  }
  remove(id: string) {
    const entry = this.connections.get(id);
    if (!entry) return;
    this.connections.delete(id);
    this.owners.delete(entry.ownerId);
  }
  entries() { return [...this.connections.values()]; }
}
