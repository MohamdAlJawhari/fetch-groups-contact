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
import type { UsersService } from './modules/users/users.service.js';
import { UsersController } from './modules/users/users.controller.js';
import { createUsersRoutes } from './modules/users/users.routes.js';

export interface AppDependencies {
  auth: AuthService;
  sessions: SessionStore;
  users: UserRepository;
  userManagement: UsersService;
  cookieSecret: string;
  production: boolean;
  loginLimiter?: express.RequestHandler;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  // Parse JSON before mounting auth routes so the limiter can read the email.
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser(dependencies.cookieSecret));
  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.use('/auth', createAuthRoutes(
    new AuthController(dependencies.auth, dependencies.production),
    dependencies.loginLimiter ?? createLoginRateLimiter(),
    requireAuth(dependencies.sessions, dependencies.users, { allowTemporaryPassword: true }),
  ));
  app.use('/admin/users', createUsersRoutes(
    new UsersController(dependencies.userManagement),
    requireAuth(dependencies.sessions, dependencies.users),
  ));
  app.use(errorHandler);
  return app;
}
