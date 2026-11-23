import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';

export const CONNECTION_RATE_LIMIT_MESSAGE = 'too many connection attempts; try again shortly';

/**
 * T23 (docs/02-non-functional-requirements.md, docs/04-api.md): at most `limit` connection starts per user per
 * `windowMs`, so nobody can hammer Telegram or WhatsApp through the app. Keyed by the authenticated user, not the
 * IP, so it must run after authentication. Every attempt counts, whatever its outcome: each one may open a socket.
 * The window starts with the first attempt and does not slide.
 */
export function createConnectionRateLimiter(options: { limit?: number; windowMs?: number; now?: () => number } = {}): RequestHandler {
  const { limit = 5, windowMs = 60_000, now = Date.now } = options;
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return (request, response, next) => {
    const userId = request.user?.id;
    if (!userId) throw new AppError(401, 'authentication required');
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
    const bucket = buckets.get(userId) ?? { count: 0, expiresAt: time + windowMs };
    if (bucket.count >= limit) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.expiresAt - time) / 1000)));
      throw new AppError(429, CONNECTION_RATE_LIMIT_MESSAGE);
    }
    bucket.count += 1;
    buckets.set(userId, bucket);
    next();
  };
}
