import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';

export const requireAdmin: RequestHandler = (request, _response, next) => {
  if (!request.user) throw new AppError(401, 'authentication required');
  if (request.user.role !== 'admin') throw new AppError(403, 'admin access required');
  next();
};
