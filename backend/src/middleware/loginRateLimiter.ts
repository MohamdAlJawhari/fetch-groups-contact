import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';

interface Bucket { count: number; expiresAt: number }
export function createLoginRateLimiter(options: {
  ipLimit?: number; emailIpLimit?: number; emailLimit?: number; windowMs?: number; now?: () => number;
} = {}): RequestHandler {
  const { ipLimit = 20, emailIpLimit = 5, emailLimit = 50, windowMs = 15 * 60 * 1000, now = Date.now } = options;
  const buckets = new Map<string, Bucket>();
  return (request, response, next) => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 255) : '';
    const keys: Array<[string, number]> = [[`ip:${request.ip}`, ipLimit]];
    const emailIpKey = email ? `email-ip:${JSON.stringify([email, request.ip])}` : undefined;
    if (emailIpKey) keys.push([emailIpKey, emailIpLimit], [`email:${email}`, emailLimit]);
    let retryAt = 0;
    for (const [key, limit] of keys) {
      const bucket = buckets.get(key);
      if (bucket && bucket.count >= limit) retryAt = Math.max(retryAt, bucket.expiresAt);
    }
    if (retryAt) {
      const seconds = Math.ceil((retryAt - time) / 1000);
      const minutes = Math.ceil(seconds / 60);
      response.setHeader('Retry-After', seconds);
      throw new AppError(429, `too many attempts; try again in ${minutes} minute${minutes === 1 ? '' : 's'}`);
    }
    // Only completed credential failures consume the allowance. Infrastructure
    // failures, rejected requests (429), and successful logins do not count.
    response.once('finish', () => {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        if (emailIpKey) buckets.delete(emailIpKey);
      } else if (response.statusCode === 401) {
        const finishedAt = now();
        for (const [key] of keys) {
          const existing = buckets.get(key);
          const bucket = existing && existing.expiresAt > finishedAt
            ? existing : { count: 0, expiresAt: finishedAt + windowMs };
          bucket.count++;
          buckets.set(key, bucket);
        }
      }
    });
    next();
  };
}
