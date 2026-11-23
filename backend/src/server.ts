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
import { ConnectionRegistry } from './modules/connections/connection.registry.js';
import { ConnectionsService } from './modules/connections/connections.service.js';
import { ConnectionReaper } from './modules/connections/connection.reaper.js';
import { createPlatform } from './platforms/platform.factory.js';

async function main() {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  const sessions = new SessionStore();
  const users = new PrismaUserRepository(prisma);
  const hasher = new BcryptPasswordHasher();
  const audit = new AuditService(new PrismaAuditRepository(prisma));
  const connectionRegistry = new ConnectionRegistry();
  if (!config.telegram) console.log('telegram: using the fake platform');
  if (config.whatsappPlatform === 'fake') console.log('whatsapp: using the fake platform');
  const connections = new ConnectionsService(connectionRegistry,
    name => createPlatform(name, { telegram: config.telegram, whatsapp: config.whatsappPlatform }), audit, users, sessions);
  const reaper = new ConnectionReaper(connectionRegistry, connections, config.connectionIdleTimeoutMs);
  const auth = new AuthService(users, hasher, audit, sessions, connections);
  const userManagement = new UsersService(users, hasher, audit, sessions, connections);
  const cleanup = setInterval(() => sessions.prune(), 60_000);
  cleanup.unref();
  const server = createApp({ auth, sessions, users, userManagement, connections, connectionRegistry, cookieSecret: config.cookieSecret,
    production: config.nodeEnv === 'production' }).listen(config.port, () => {
    console.log(`Backend listening on port ${config.port}`);
  });
  reaper.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const stoppedReaper = reaper.stop().then(() => true, () => false);
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close(() => {
      void (async () => {
        let exitCode = 0;
        if (!(await stoppedReaper)) exitCode = 1;
        try { await connections.shutdown(); }
        catch { console.error('Connection shutdown failed'); exitCode = 1; }
        try { await prisma.$disconnect(); }
        finally { clearTimeout(timeout); process.exit(exitCode); }
      })();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.on('error', () => {
    console.error('HTTP server failed to start. Check PORT and whether it is in use.');
    clearInterval(cleanup);
    void reaper.stop().finally(() => connections.shutdown())
      .finally(() => prisma.$disconnect()).finally(() => process.exit(1));
  });
}

main().catch(async () => {
  console.error('Backend startup failed. Check DATABASE_URL and PostgreSQL availability.');
  await prisma.$disconnect();
  process.exitCode = 1;
});
