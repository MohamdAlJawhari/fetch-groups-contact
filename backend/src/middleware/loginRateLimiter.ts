import type { RequestHandler } from 'express';
import { AppError, LOGIN_FAILURE } from '../shared/errors.js';

interface Bucket { count: number; expiresAt: number }
export function createLoginRateLimiter(options: {
  ipLimit?: number; emailLimit?: number; windowMs?: number; now?: () => number;
} = {}): RequestHandler {
  const { ipLimit = 20, emailLimit = 5, windowMs = 15 * 60 * 1000, now = Date.now } = options;
  const buckets = new Map<string, Bucket>();
  return (request, response, next) => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 255) : '';
    const keys: Array<[string, number]> = [[`ip:${request.ip}`, ipLimit]];
    if (email) keys.push([`email:${email}`, emailLimit]);
    let retryAt = 0;
    for (const [key, limit] of keys) {
      const bucket = buckets.get(key) ?? { count: 0, expiresAt: time + windowMs };
      bucket.count++;
      buckets.set(key, bucket);
      if (bucket.count > limit) retryAt = Math.max(retryAt, bucket.expiresAt);
    }
    if (retryAt) {
      response.setHeader('Retry-After', Math.ceil((retryAt - time) / 1000));
      throw new AppError(429, LOGIN_FAILURE);
    }
    next();
  };
}
