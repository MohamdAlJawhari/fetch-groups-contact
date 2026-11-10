import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'session';
export interface Session { userId: string; expiresAt: number }

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}
  create(userId: string) {
    this.prune();
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, { userId, expiresAt: this.now() + SESSION_TTL_MS });
    return id;
  }
  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session && session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }
  remove(id: string) { this.sessions.delete(id); }
  removeForUser(userId: string) {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(id);
    }
  }
  prune() {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= this.now()) this.sessions.delete(id);
    }
  }
}
