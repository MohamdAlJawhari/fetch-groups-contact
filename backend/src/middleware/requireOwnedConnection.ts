import type { RequestHandler } from 'express';
import type { ConnectionRegistry } from '../modules/connections/connection.registry.js';
import { AppError } from '../shared/errors.js';

export function requireOwnedConnection(registry: ConnectionRegistry): RequestHandler {
  return (request, _response, next) => {
    if (!request.user) throw new AppError(401, 'authentication required');
    const id = request.params.id;
    const entry = typeof id === 'string' ? registry.get(id) : undefined;
    if (!entry || entry.ownerId !== request.user.id) throw new AppError(404, 'connection not found');
    registry.touch(entry.id);
    next();
  };
}
