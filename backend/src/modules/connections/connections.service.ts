import { AppError } from '../../shared/errors.js';
import type { PlatformFactory, PlatformName } from '../../platforms/platform.types.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UserRepository } from '../users/users.repository.js';
import type { SessionStore } from '../auth/session.store.js';
import { ConnectionRegistry, type ConnectionEntry } from './connection.registry.js';

export class ConnectionsService {
  private readonly locks = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly factory: PlatformFactory,
    private readonly audit: AuditService,
    private readonly users: UserRepository,
    private readonly sessions: SessionStore,
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
      if (entry?.ownerId === ownerId && entry.lastActivity < cutoff) await this.end(entry);
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
  private async end(entry: ConnectionEntry) {
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
