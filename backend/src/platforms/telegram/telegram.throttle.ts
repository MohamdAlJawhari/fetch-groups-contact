import { PlatformError } from '../platform.errors.js';

export interface TelegramThrottleOptions {
  /** Minimum time between request starts (spec 06, 4.6: 1 s). */
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Flood seconds from a GramJS FloodWaitError (or any error carrying `seconds` with a FLOOD_* code). */
function floodSeconds(error: unknown): number | undefined {
  const { errorMessage, seconds } = (error ?? {}) as { errorMessage?: unknown; seconds?: unknown };
  return typeof errorMessage === 'string' && errorMessage.startsWith('FLOOD') && typeof seconds === 'number' && seconds > 0
    ? seconds : undefined;
}

/**
 * One per connection (docs/specs/06-telegram.md 4.6): one request at a time, at least `gapMs` between starts.
 * GramJS sleeps out short flood waits itself; a flood wait that reaches us blocks every further request on this
 * connection until it has passed, failing them at once without calling Telegram.
 */
export class TelegramThrottle {
  private tail: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private blockedUntil = 0;
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TelegramThrottleOptions = {}) {
    this.gapMs = options.gapMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  run<T>(request: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.now() < this.blockedUntil) throw new PlatformError('unavailable');
      const wait = this.lastStart + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      try {
        return await request();
      } catch (error) {
        const seconds = floodSeconds(error);
        if (seconds !== undefined) {
          this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1_000);
          console.error('Telegram flood wait', { seconds });
        }
        throw error;
      }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
