import { createApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './database/prisma.js';
import { BcryptPasswordHasher } from './modules/auth/password.hasher.js';
import { SessionStore } from './modules/auth/session.store.js';
import { PrismaUserRepository } from './modules/users/users.repository.js';
import { PrismaAuditRepository } from './modules/audit/audit.repository.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { UsersService } from './modules/users/users.service.js';

async function main() {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  const sessions = new SessionStore();
  const users = new PrismaUserRepository(prisma);
  const hasher = new BcryptPasswordHasher();
  const audit = new AuditService(new PrismaAuditRepository(prisma));
  const auth = new AuthService(users, hasher, audit, sessions);
  const userManagement = new UsersService(users, hasher, audit, sessions);
  const cleanup = setInterval(() => sessions.prune(), 60_000);
  cleanup.unref();
  const server = createApp({ auth, sessions, users, userManagement, cookieSecret: config.cookieSecret,
    production: config.nodeEnv === 'production' }).listen(config.port, () => {
    console.log(`Backend listening on port ${config.port}`);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close(() => {
      void prisma.$disconnect().finally(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.on('error', () => {
    console.error('HTTP server failed to start. Check PORT and whether it is in use.');
    void prisma.$disconnect().finally(() => process.exit(1));
  });
}

main().catch(async () => {
  console.error('Backend startup failed. Check DATABASE_URL and PostgreSQL availability.');
  await prisma.$disconnect();
  process.exitCode = 1;
});
