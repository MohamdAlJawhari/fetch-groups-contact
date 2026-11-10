import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth } from './middleware/requireAuth.js';
import { createLoginRateLimiter } from './middleware/loginRateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { createAuthRoutes } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import type { SessionStore } from './modules/auth/session.store.js';
import type { UserRepository } from './modules/users/users.repository.js';

export interface AppDependencies {
  auth: AuthService;
  sessions: SessionStore;
  users: UserRepository;
  cookieSecret: string;
  production: boolean;
  loginLimiter?: express.RequestHandler;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser(dependencies.cookieSecret));
  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.use('/auth', createAuthRoutes(
    new AuthController(dependencies.auth, dependencies.production),
    requireAuth(dependencies.sessions, dependencies.users),
    dependencies.loginLimiter ?? createLoginRateLimiter(),
  ));
  app.use(errorHandler);
  return app;
}
