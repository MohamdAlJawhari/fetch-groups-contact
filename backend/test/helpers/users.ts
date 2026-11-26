import { randomUUID } from 'node:crypto';
import type { User } from '../../src/generated/prisma/client.js';
import { deletedEmailPlaceholder, type AdminUserRepository } from '../../src/modules/users/users.repository.js';
import { AppError } from '../../src/shared/errors.js';

export class MemoryUserRepository implements AdminUserRepository {
  readonly records: Map<string, User>;
  constructor(users: User[]) { this.records = new Map(users.map(user => [user.id, user])); }
  async findById(id: string) { return this.records.get(id) ?? null; }
  async findByEmail(email: string) { return [...this.records.values()].find(user => user.email === email) ?? null; }
  private get(id: string) {
    const user = this.records.get(id);
    if (!user) throw new AppError(404, 'user not found');
    return user;
  }
  async setLastLogin(id: string) { this.get(id).lastLoginAt = new Date(); }
  async changePassword(id: string, passwordHash: string) {
    Object.assign(this.get(id), {passwordHash, mustChangePassword: false});
  }
  async list() { return [...this.records.values()].filter(user => !user.deletedAt); }
  async markDeleted(id: string) {
    const user = this.records.get(id);
    if (!user || user.deletedAt) throw new AppError(404, 'user not found');
    return Object.assign(user, {deletedAt: new Date(), deletedEmail: user.email, email: deletedEmailPlaceholder(id), isActive: false});
  }
  async create(email: string, passwordHash: string) {
    if (await this.findByEmail(email)) throw new AppError(409, 'email already exists');
    const user: User = {id: randomUUID(), email, passwordHash, role: 'user', isActive: true,
      mustChangePassword: true, createdAt: new Date(), lastLoginAt: null, deletedAt: null, deletedEmail: null};
    this.records.set(user.id, user);
    return user;
  }
  async resetPassword(id: string, passwordHash: string) {
    return Object.assign(this.get(id), {passwordHash, mustChangePassword: true});
  }
  async setActive(id: string, isActive: boolean) { return Object.assign(this.get(id), {isActive}); }
}
