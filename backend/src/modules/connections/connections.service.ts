import type { Writable } from 'node:stream';
import { AppError } from '../../shared/errors.js';
import { exportFilename, zipEntryNames, type ExportFiles } from '../../export/export.filename.js';
import { ExportService } from '../../export/export.service.js';
import { PlatformError } from '../../platforms/platform.errors.js';
import type { PlatformFactory, PlatformName } from '../../platforms/platform.types.js';
import type { AuditAction } from '../../shared/types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UserRepository } from '../users/users.repository.js';
import type { SessionStore } from '../auth/session.store.js';
import { ConnectionRegistry, type ConnectionEntry } from './connection.registry.js';

const PLATFORM_READ_FAILURE = 'could not read contacts from the platform; please try again';
const PLATFORM_UNREACHABLE = 'could not reach the platform; please try again';
const MAX_WRONG_PASSWORDS = 5;
const PLATFORM_TITLES: Record<PlatformName, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };

interface ExportAudit { started: AuditAction; finished: AuditAction; failed: AuditAction }
const GROUP_EXPORT: ExportAudit = { started: 'export_started', finished: 'export_finished', failed: 'export_failed' };
const CONTACTS_EXPORT: ExportAudit = {
  started: 'contacts_export_started', finished: 'contacts_export_finished', failed: 'contacts_export_failed',
};

/** A fetched export, ready to stream. `write` never rejects: failures cut the stream off and are audited. */
export interface ExportJob {
  platform: PlatformName;
  startedAt: Date;
  /** `zip` for "separate files" with two or more groups (spec 05, 4.6). */
  kind: 'xlsx' | 'zip';
  /** The download name; it may contain a group title, so it's never logged or audited. */
  filename: string;
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
        if (error instanceof PlatformError && error.code === 'unavailable') throw new AppError(502, PLATFORM_UNREACHABLE);
        throw error;
      }
    });
  }

  /** docs/specs/06-telegram.md 3.3. The password is passed on and never kept, logged, or audited. */
  submitPassword(ownerId: string, id: string, password: string) {
    return this.withOwner(ownerId, async () => {
      const entry = this.owned(ownerId, id);
      if (!entry.platform.submitPassword || (await entry.platform.getStatus()).status !== 'password-required') {
        throw new AppError(409, 'connection is not waiting for a password');
      }
      try {
        await entry.platform.submitPassword(password);
      } catch (error) {
        if (!(error instanceof PlatformError && error.code === 'wrong_password')) throw new AppError(502, PLATFORM_UNREACHABLE);
        entry.wrongPasswords += 1;
        if (entry.wrongPasswords < MAX_WRONG_PASSWORDS) throw new AppError(400, 'wrong two-step verification password');
        await this.end(entry);
        throw new AppError(400, 'too many wrong passwords; start again');
      }
      return this.view(entry);
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
      try { return await entry.platform.listGroups(); }
      catch { throw new AppError(502, PLATFORM_READ_FAILURE); }
    });
  }
  /**
   * docs/specs/05-export.md section 4.4. Validation runs under the per-user lock; fetching and
   * streaming do not, so status polls and DELETE stay responsive during a long export.
   */
  async export(ownerId: string, id: string, groupIds: readonly string[], files: ExportFiles = 'merged'): Promise<ExportJob> {
    let titles: string[] = [];
    // Spec 4.6: "separate" only means something for two or more groups.
    const separate = files === 'separate' && groupIds.length > 1;
    return this.runJob(ownerId, id, { audit: GROUP_EXPORT, selectedIds: groupIds,
      validate: async entry => {
        let known: Map<string, string>;
        try { known = new Map((await entry.platform.listGroups()).map(group => [group.id, group.title])); }
        catch { throw new AppError(502, PLATFORM_READ_FAILURE); }
        if (groupIds.some(groupId => !known.has(groupId))) throw new AppError(400, 'unknown group selected');
        titles = groupIds.map(groupId => known.get(groupId)!);
      },
      prepare: async (entry, date) => {
        const filename = exportFilename(titles, date, separate ? 'separate' : 'merged');
        if (separate) {
          const perGroup = await this.exporter.prepareEach(entry.platform, groupIds);
          const names = zipEntryNames(titles, date);
          return { kind: 'zip', filename,
            write: out => this.exporter.writeZip(perGroup.map((contacts, index) => ({ name: names[index]!, contacts })), out) };
        }
        const contacts = await this.exporter.prepare(entry.platform, groupIds);
        return { kind: 'xlsx', filename, write: out => this.exporter.write(contacts, out) };
      },
    });
  }

  /**
   * docs/specs/09-phone-contacts.md: the same rules as the group export, with its own file and audit actions.
   * Like every export, the connection is kept after a successful download (the user, 2026-11-26).
   */
  exportAddressBook(ownerId: string, id: string): Promise<ExportJob> {
    return this.runJob(ownerId, id, { audit: CONTACTS_EXPORT, selectedIds: [],
      validate: async () => {},
      prepare: async (entry, date) => {
        const book = await this.exporter.prepareAddressBook(entry.platform);
        return { kind: 'xlsx', filename: `Phone contacts - ${PLATFORM_TITLES[entry.platformName]} - ${date}.xlsx`,
          write: out => this.exporter.writeAddressBook(book, out) };
      },
    });
  }

  /** Spec 05, 4.4, shared by both exports: checks under the lock, then fetching and streaming outside it. */
  private async runJob(ownerId: string, id: string, job: {
    audit: ExportAudit; selectedIds: readonly string[];
    validate(entry: ConnectionEntry): Promise<void>;
    prepare(entry: ConnectionEntry, date: string): Promise<Pick<ExportJob, 'kind' | 'filename'> & { write(out: Writable): Promise<void> }>;
  }): Promise<ExportJob> {
    const entry = await this.withOwner(ownerId, async () => {
      const entry = this.owned(ownerId, id);
      if (entry.exporting) throw new AppError(409, 'an export is already running');
      if ((await entry.platform.getStatus()).status !== 'connected') {
        throw new AppError(409, 'connection is not connected yet');
      }
      await job.validate(entry);
      await this.audit.record(ownerId, job.audit.started, entry.platformName);
      entry.exporting = true;
      return entry;
    });
    const startedAt = new Date(this.now());
    let prepared: Awaited<ReturnType<typeof job.prepare>>;
    try {
      prepared = await job.prepare(entry, startedAt.toISOString().slice(0, 10));
    } catch (error) {
      throw await this.withOwner(ownerId, async () => {
        const live = this.isLive(entry);
        if (live) { entry.exporting = false; this.registry.touch(entry.id); }
        await this.audit.record(ownerId, job.audit.failed, entry.platformName);
        if (!live) return new AppError(404, 'connection not found');
        if (error instanceof PlatformError && error.code === 'members_hidden') {
          // Only IDs the user selected, so nothing new leaks (spec 06, 3.4).
          const hidden = (error.groupIds ?? []).filter(groupId => job.selectedIds.includes(groupId));
          return new AppError(400, 'a selected group hides its member list', hidden);
        }
        return new AppError(502, PLATFORM_READ_FAILURE);
      });
    }
    const state: StreamState = { aborted: false };
    await this.withOwner(ownerId, async () => {
      if (!this.isLive(entry)) {
        await this.audit.record(ownerId, job.audit.failed, entry.platformName);
        throw new AppError(404, 'connection not found');
      }
      entry.abortExport = () => {
        state.aborted = true;
        state.out?.destroy(new Error('Connection ended during export'));
      };
    });
    return {
      platform: entry.platformName,
      startedAt,
      kind: prepared.kind,
      filename: prepared.filename,
      write: out => this.streamExport(entry, prepared.write, out, state, job.audit),
    };
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
  private async streamExport(entry: ConnectionEntry, write: (out: Writable) => Promise<void>, out: Writable, state: StreamState,
    audit: ExportAudit) {
    state.out = out;
    let succeeded = false;
    try {
      if (state.aborted) throw new Error('Connection ended during export');
      await write(out);
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
        await this.audit.record(entry.ownerId, succeeded ? audit.finished : audit.failed, entry.platformName);
        if (!live) return;
        if (succeeded) {
          // Spec 05, 4.4 (2026-11-26): keep the link for more exports until Disconnect; the idle timer restarts now.
          entry.exporting = false;
          this.registry.touch(entry.id);
        } else {
          await this.end(entry);
        }
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
