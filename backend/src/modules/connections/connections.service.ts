import type { Writable } from 'node:stream';
import { AppError } from '../../shared/errors.js';
import { ExportService } from '../../export/export.service.js';
import type { CategorizedContacts, PlatformFactory, PlatformName } from '../../platforms/platform.types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UserRepository } from '../users/users.repository.js';
import type { SessionStore } from '../auth/session.store.js';
import { ConnectionRegistry, type ConnectionEntry } from './connection.registry.js';

const PLATFORM_READ_FAILURE = 'could not read contacts from the platform; please try again';

/** A fetched export, ready to stream. `write` never rejects: failures cut the stream off and are audited. */
export interface ExportJob {
  platform: PlatformName;
  startedAt: Date;
  write(out: Writable): Promise<void>;
}

interface StreamState { out?: Writable; aborted: boolean }

export class ConnectionsService {
  private readonly locks = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly factory: PlatformFactory,
    private readonly audit: AuditService,
    private readonly users: UserRepository,
    private readonly sessions: SessionStore,
    private readonly exporter: ExportService = new ExportService(),
    private readonly now: () => number = Date.now,
  ) {}

  start(ownerId: string, platformName: PlatformName, sessionId: string) {
    return this.withOwner(ownerId, async () => {
      if (this.stopping) throw new AppError(503, 'server is shutting down');
      await this.authorizeStart(ownerId, sessionId);
      const existing = this.registry.getByOwner(ownerId);
      if (existing) await this.end(existing);
      const platform = this.factory(platformName);
      let entry: ConnectionEntry | undefined;
      let started = false;
      try {
        await platform.connect();
        // Logout or disable may have happened while connect was pending.
        await this.authorizeStart(ownerId, sessionId);
        entry = this.registry.add(ownerId, platformName, platform);
        await this.audit.record(ownerId, 'connection_started', platformName);
        started = true;
        return await this.view(entry);
      } catch (error) {
        if (entry && started) await this.end(entry);
        else {
          if (entry) this.registry.remove(entry.id);
          await platform.disconnect();
        }
        throw error;
      }
    });
  }

  status(ownerId: string, id: string) {
    return this.withOwner(ownerId, () => this.view(this.owned(ownerId, id)));
  }
  groups(ownerId: string, id: string) {
    return this.withOwner(ownerId, async () => {
      const entry = this.owned(ownerId, id);
      if ((await entry.platform.getStatus()).status !== 'connected') {
        throw new AppError(409, 'connection is not connected yet');
      }
      return entry.platform.listGroups();
    });
  }
  /**
   * docs/specs/05-export.md section 4.4. Validation runs under the per-user lock; fetching and
   * streaming do not, so status polls and DELETE stay responsive during a long export.
   */
  async export(ownerId: string, id: string, groupIds: readonly string[]): Promise<ExportJob> {
    const entry = await this.withOwner(ownerId, async () => {
      const entry = this.owned(ownerId, id);
      if (entry.exporting) throw new AppError(409, 'an export is already running');
      if ((await entry.platform.getStatus()).status !== 'connected') {
        throw new AppError(409, 'connection is not connected yet');
      }
      let known: Set<string>;
      try { known = new Set((await entry.platform.listGroups()).map(group => group.id)); }
      catch { throw new AppError(502, PLATFORM_READ_FAILURE); }
      if (groupIds.some(groupId => !known.has(groupId))) throw new AppError(400, 'unknown group selected');
      await this.audit.record(ownerId, 'export_started', entry.platformName);
      entry.exporting = true;
      return entry;
    });
    const startedAt = new Date(this.now());
    let contacts: CategorizedContacts;
    try {
      contacts = await this.exporter.prepare(entry.platform, groupIds);
    } catch {
      throw await this.withOwner(ownerId, async () => {
        const live = this.isLive(entry);
        if (live) { entry.exporting = false; this.registry.touch(entry.id); }
        await this.audit.record(ownerId, 'export_failed', entry.platformName);
        return live ? new AppError(502, PLATFORM_READ_FAILURE) : new AppError(404, 'connection not found');
      });
    }
    const state: StreamState = { aborted: false };
    await this.withOwner(ownerId, async () => {
      if (!this.isLive(entry)) {
        await this.audit.record(ownerId, 'export_failed', entry.platformName);
        throw new AppError(404, 'connection not found');
      }
      entry.abortExport = () => {
        state.aborted = true;
        state.out?.destroy(new Error('Connection ended during export'));
      };
    });
    return { platform: entry.platformName, startedAt, write: out => this.streamExport(entry, contacts, out, state) };
  }

  disconnect(ownerId: string, id: string) {
    return this.withOwner(ownerId, () => this.end(this.owned(ownerId, id)));
  }
  destroyForUser(ownerId: string) {
    return this.withOwner(ownerId, async () => {
      const entry = this.registry.getByOwner(ownerId);
      if (entry) await this.end(entry);
    });
  }
  disconnectIfIdle(ownerId: string, id: string, cutoff: number) {
    return this.withOwner(ownerId, async () => {
      const entry = this.registry.get(id);
      if (entry?.ownerId === ownerId && !entry.exporting && entry.lastActivity < cutoff) await this.end(entry);
    });
  }
  async shutdown() {
    this.stopping = true;
    const owners = new Set([...this.locks.keys(), ...this.registry.entries().map(entry => entry.ownerId)]);
    const results = await Promise.allSettled([...owners].map(owner => this.destroyForUser(owner)));
    if (results.some(result => result.status === 'rejected')) throw new Error('Connection shutdown failed');
  }
  private owned(ownerId: string, id: string) {
    const entry = this.registry.get(id);
    if (!entry || entry.ownerId !== ownerId) throw new AppError(404, 'connection not found');
    this.registry.touch(id);
    return entry;
  }
  private async authorizeStart(ownerId: string, sessionId: string) {
    if (this.sessions.get(sessionId)?.userId !== ownerId) throw new AppError(401, 'authentication required');
    const user = await this.users.findById(ownerId);
    if (!user?.isActive) throw new AppError(401, 'authentication required');
    if (user.mustChangePassword) throw new AppError(403, 'password change required');
  }
  private async view(entry: ConnectionEntry) {
    return { id: entry.id, platform: entry.platformName, ...await entry.platform.getStatus() };
  }
  private isLive(entry: ConnectionEntry) { return this.registry.get(entry.id) === entry; }
  private async streamExport(entry: ConnectionEntry, contacts: CategorizedContacts, out: Writable, state: StreamState) {
    state.out = out;
    let succeeded = false;
    try {
      if (state.aborted) throw new Error('Connection ended during export');
      await this.exporter.write(contacts, out);
      succeeded = true;
    } catch (error) {
      // Only the class name: platform and stream messages may carry contact data.
      console.error('Export stream failed', { kind: error instanceof Error ? error.constructor.name : 'unknown' });
      if (!out.destroyed) out.destroy();
    }
    try {
      await this.withOwner(entry.ownerId, async () => {
        entry.abortExport = undefined;
        const live = this.isLive(entry);
        await this.audit.record(entry.ownerId, succeeded ? 'export_finished' : 'export_failed', entry.platformName);
        if (live) await this.end(entry);
      });
    } catch {
      console.error('Export cleanup failed');
    }
  }
  private async end(entry: ConnectionEntry) {
    entry.abortExport?.();
    entry.abortExport = undefined;
    try { await entry.platform.disconnect(); }
    finally {
      this.registry.remove(entry.id);
      await this.audit.record(entry.ownerId, 'connection_ended', entry.platformName);
    }
  }
  private withOwner<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(ownerId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => {}, () => {});
    this.locks.set(ownerId, tail);
    void tail.then(() => { if (this.locks.get(ownerId) === tail) this.locks.delete(ownerId); });
    return result;
  }
}
