import { randomBytes } from 'node:crypto';
import type { User } from '../../generated/prisma/client.js';
import { ACCOUNT_DISABLED, AppError, LOGIN_FAILURE } from '../../shared/errors.js';
import type { AuthenticatedUser } from '../../shared/types.js';
import type { UserRepository } from '../users/users.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordHasher } from './password.hasher.js';
import { SessionStore } from './session.store.js';
import { emailSchema, newPasswordProblem } from './auth.validation.js';
import type { ConnectionsService } from '../connections/connections.service.js';

export function publicUser(user: User): AuthenticatedUser {
  return { id: user.id, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword };
}

export class AuthService {
  private readonly dummyHash: Promise<string>;
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly sessions: SessionStore,
    private readonly connections: Pick<ConnectionsService, 'destroyForUser'>,
  ) {
    this.dummyHash = hasher.hash(randomBytes(24).toString('hex'));
  }
  async login(email: string, password: string, previousSessionId?: string) {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) throw new AppError(401, LOGIN_FAILURE);
    const user = await this.users.findByEmail(parsed.data);
    const valid = await this.hasher.verify(password, user?.passwordHash ?? await this.dummyHash);
    // A deleted account (T52) is treated as unknown, never as "disabled".
    if (!user || user.deletedAt || !valid) throw new AppError(401, LOGIN_FAILURE);
    // Only after the right password (2026-11-26): a stranger still can't tell a disabled account from a wrong
    // email, but the real owner learns to ask the admin. 403 doesn't count toward the login limiter.
    if (!user.isActive) throw new AppError(403, ACCOUNT_DISABLED);
    await this.users.setLastLogin(user.id);
    await this.audit.record(user.id, 'login');
    if (previousSessionId) this.sessions.remove(previousSessionId);
    return { user: publicUser(user), sessionId: this.sessions.create(user.id) };
  }
  async logout(sessionId: string, userId: string) {
    this.sessions.remove(sessionId);
    await this.connections.destroyForUser(userId);
    await this.audit.record(userId, 'logout');
  }
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const problem = newPasswordProblem(newPassword);
    if (problem) throw new AppError(400, problem);
    const user = await this.users.findById(userId);
    if (!user?.isActive) throw new AppError(401, 'authentication required');
    if (!(await this.hasher.verify(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'current password is incorrect');
    }
    if (await this.hasher.verify(newPassword, user.passwordHash)) {
      throw new AppError(400, 'new password must differ from current password');
    }
    await this.users.changePassword(userId, await this.hasher.hash(newPassword));
    this.sessions.removeForUser(userId);
    await this.connections.destroyForUser(userId);
    await this.audit.record(userId, 'password_changed');
  }
}
