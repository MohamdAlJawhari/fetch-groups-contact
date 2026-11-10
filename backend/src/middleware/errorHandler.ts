import type { ErrorRequestHandler } from 'express';
import { AppError, LOGIN_FAILURE } from '../shared/errors.js';

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const status = error instanceof AppError ? error.status
    : error?.type === 'entity.parse.failed' ? 400
    : error?.type === 'entity.too.large' ? 413 : 500;
  const message = request.path === '/auth/login' ? LOGIN_FAILURE
    : error instanceof AppError ? error.message
    : status === 400 ? 'invalid JSON' : status === 413 ? 'request too large' : 'internal server error';
  response.status(status).json({ message });
};
