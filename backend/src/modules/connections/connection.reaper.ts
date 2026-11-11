import type { ConnectionRegistry } from './connection.registry.js';
import type { ConnectionsService } from './connections.service.js';

export class ConnectionReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly connections: ConnectionsService,
    private readonly timeoutMs = 600_000,
    private readonly now: () => number = Date.now,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => console.error('Connection reaper cleanup failed'));
    }, 60_000);
    this.timer.unref();
  }
  runOnce() {
    if (this.running) return this.running;
    const cutoff = this.now() - this.timeoutMs;
    this.running = (async () => {
      const results = await Promise.allSettled(this.registry.entries().map(entry =>
        this.connections.disconnectIfIdle(entry.ownerId, entry.id, cutoff)));
      if (results.some(result => result.status === 'rejected')) throw new Error('Connection reaper cleanup failed');
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
