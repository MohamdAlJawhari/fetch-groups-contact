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
import { createConnectionsRoutes } from './modules/connections/connections.routes.js';
import { ConnectionsController } from './modules/connections/connections.controller.js';
import type { ConnectionsService } from './modules/connections/connections.service.js';
import type { ConnectionRegistry } from './modules/connections/connection.registry.js';
import { requireOwnedConnection } from './middleware/requireOwnedConnection.js';

export interface AppDependencies {
  auth: AuthService;
  sessions: SessionStore;
  users: UserRepository;
  userManagement: UsersService;
  connections: ConnectionsService;
  connectionRegistry: ConnectionRegistry;
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
  // All connection routes inherit the temporary-password gate.
  app.use('/connections', createConnectionsRoutes(
    new ConnectionsController(dependencies.connections),
    requireAuth(dependencies.sessions, dependencies.users),
    requireOwnedConnection(dependencies.connectionRegistry),
  ));
  app.use(errorHandler);
  return app;
}
