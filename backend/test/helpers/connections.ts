import { ConnectionRegistry } from '../../src/modules/connections/connection.registry.js';
import { ConnectionsService } from '../../src/modules/connections/connections.service.js';
import { createPlatform } from '../../src/platforms/platform.factory.js';
import type { FakePlatformOptions } from '../../src/platforms/fake.platform.js';
import type { UserRepository } from '../../src/modules/users/users.repository.js';
import type { SessionStore } from '../../src/modules/auth/session.store.js';
import type { AuditService } from '../../src/modules/audit/audit.service.js';

export function createConnectionServices(users: UserRepository, sessions: SessionStore, audit: AuditService, options: FakePlatformOptions = {}) {
  const connectionRegistry = new ConnectionRegistry(options.now);
  const connections = new ConnectionsService(connectionRegistry, name => createPlatform(name, options), audit, users, sessions);
  return { connections, connectionRegistry };
}
