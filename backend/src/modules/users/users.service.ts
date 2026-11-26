import { randomBytes } from 'node:crypto';
import type { User } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import type { PasswordHasher } from '../auth/password.hasher.js';
import type { SessionStore } from '../auth/session.store.js';
import { emailSchema } from '../auth/auth.validation.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AdminUserRepository } from './users.repository.js';
import type { ConnectionsService } from '../connections/connections.service.js';

export function publicAdminUser(user: User) {
  return {
    id: user.id, email: user.email, role: user.role, isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
  };
}

export class UsersService {
  constructor(
    private readonly users: AdminUserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly sessions: SessionStore,
    private readonly connections: Pick<ConnectionsService, 'destroyForUser'>,
  ) {}

  async list() {
    const users = await this.users.list();
    return users.map(publicAdminUser);
  }

  async create(actorId: string, email: string) {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) throw new AppError(400, 'provide a valid email');
    if (await this.users.findByEmail(parsed.data)) throw new AppError(409, 'email already exists');
    const temporaryPassword = randomBytes(24).toString('base64url');
    const user = await this.users.create(parsed.data, await this.hasher.hash(temporaryPassword));
    await this.audit.record(actorId, 'admin_user_created', undefined, user.id);
    return { user: publicAdminUser(user), temporaryPassword };
  }

  async resetPassword(actorId: string, userId: string) {
    await this.liveUser(userId);
    const temporaryPassword = randomBytes(24).toString('base64url');
    const user = await this.users.resetPassword(userId, await this.hasher.hash(temporaryPassword));
    this.sessions.removeForUser(userId);
    await this.connections.destroyForUser(userId);
    await this.audit.record(actorId, 'admin_password_reset', undefined, userId);
    return { user: publicAdminUser(user), temporaryPassword };
  }

  async setActive(actorId: string, userId: string, isActive: boolean) {
    if (!isActive && actorId === userId) throw new AppError(400, 'you cannot disable your own account');
    await this.liveUser(userId); // a deleted account can't be enabled again
    const user = await this.users.setActive(userId, isActive);
    if (!isActive) {
      this.sessions.removeForUser(userId);
      await this.connections.destroyForUser(userId);
    }
    await this.audit.record(actorId, isActive ? 'admin_user_enabled' : 'admin_user_disabled', undefined, userId);
    return publicAdminUser(user);
  }

  /**
   * T52 (the user's decision, 2026-11-26): the account leaves the list, can never log in again, and its email is
   * free for a new account. The row and its audit history stay; the old email is kept in `deleted_email`.
   */
  async remove(actorId: string, userId: string) {
    if (actorId === userId) throw new AppError(400, 'you cannot delete your own account');
    await this.users.markDeleted(userId);
    this.sessions.removeForUser(userId);
    await this.connections.destroyForUser(userId);
    await this.audit.record(actorId, 'admin_user_deleted', undefined, userId);
  }

  private async liveUser(userId: string) {
    const user = await this.users.findById(userId);
    if (!user || user.deletedAt) throw new AppError(404, 'user not found');
    return user;
  }
}
