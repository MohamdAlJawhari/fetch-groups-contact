import type { ErrorRequestHandler } from 'express';
import { AppError, LOGIN_FAILURE } from '../shared/errors.js';
import { randomUUID } from 'node:crypto';

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const status = error instanceof AppError ? error.status
    : error?.type === 'entity.parse.failed' ? 400
    : error?.type === 'entity.too.large' ? 413 : 500;
  if (status >= 500) {
    // Never log raw errors, messages, stacks, request bodies, headers, cookies,
    // or URLs: any of those can contain passwords or database credentials.
    const code = error?.code;
    console.error('Internal request error', {
      errorId: randomUUID(),
      status,
      endpoint: ['/auth/login', '/auth/logout', '/auth/change-password'].includes(request.path)
        ? request.path : 'other',
      kind: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'unknown',
      code: typeof code === 'string' && /^(P\d{4}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|23505|23503|40001|53300|57P01)$/.test(code)
        ? code : undefined,
    });
  }
  const message = status === 429 && error instanceof AppError ? error.message
    : request.path === '/auth/login' ? LOGIN_FAILURE
    : error instanceof AppError ? error.message
    : status === 400 ? 'invalid JSON' : status === 413 ? 'request too large' : 'internal server error';
  response.status(status).json({ message });
};
