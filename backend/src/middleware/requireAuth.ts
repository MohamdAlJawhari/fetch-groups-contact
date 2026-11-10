import type { RequestHandler } from 'express';
import type { UserRepository } from '../modules/users/users.repository.js';
import { publicUser } from '../modules/auth/auth.service.js';
import { SESSION_COOKIE, SessionStore } from '../modules/auth/session.store.js';
import { AppError } from '../shared/errors.js';

export function requireAuth(sessions: SessionStore, users: UserRepository): RequestHandler {
  return async (request, _response, next) => {
    const id = request.signedCookies?.[SESSION_COOKIE];
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) throw new AppError(401, 'authentication required');
    const user = await users.findById(session.userId);
    if (!user?.isActive) {
      sessions.remove(id);
      throw new AppError(401, 'authentication required');
    }
    request.user = publicUser(user);
    request.sessionId = id;
    next();
  };
}
