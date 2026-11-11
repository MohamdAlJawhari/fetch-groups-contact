import { randomBytes } from 'node:crypto';
import type { User } from '../../generated/prisma/client.js';
import { AppError, LOGIN_FAILURE } from '../../shared/errors.js';
import type { AuthenticatedUser } from '../../shared/types.js';
import type { UserRepository } from '../users/users.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PasswordHasher } from './password.hasher.js';
import { SessionStore } from './session.store.js';
import { newPasswordSchema, PASSWORD_REQUIREMENTS } from './auth.validation.js';

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
  ) {
    this.dummyHash = hasher.hash(randomBytes(24).toString('hex'));
  }
  async login(email: string, password: string, previousSessionId?: string) {
    const user = await this.users.findByEmail(email);
    const valid = await this.hasher.verify(password, user?.passwordHash ?? await this.dummyHash);
    if (!user || !valid || !user.isActive) throw new AppError(401, LOGIN_FAILURE);
    await this.users.setLastLogin(user.id);
    await this.audit.record(user.id, 'login');
    if (previousSessionId) this.sessions.remove(previousSessionId);
    return { user: publicUser(user), sessionId: this.sessions.create(user.id) };
  }
  async logout(sessionId: string, userId: string) {
    this.sessions.remove(sessionId);
    await this.audit.record(userId, 'logout');
  }
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPasswordSchema.safeParse(newPassword).success) {
      throw new AppError(400, PASSWORD_REQUIREMENTS);
    }
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
    await this.audit.record(userId, 'password_changed');
  }
}
