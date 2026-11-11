import type { PrismaClient, User } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  setLastLogin(id: string): Promise<void>;
  changePassword(id: string, passwordHash: string): Promise<void>;
}

export interface AdminUserRepository extends UserRepository {
  list(): Promise<User[]>;
  create(email: string, passwordHash: string): Promise<User>;
  resetPassword(id: string, passwordHash: string): Promise<User>;
  setActive(id: string, isActive: boolean): Promise<User>;
}

export class PrismaUserRepository implements AdminUserRepository {
  constructor(private readonly db: PrismaClient) {}
  findByEmail(email: string) { return this.db.user.findUnique({ where: { email } }); }
  findById(id: string) { return this.db.user.findUnique({ where: { id } }); }
  async setLastLogin(id: string) {
    await this.db.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }
  async changePassword(id: string, passwordHash: string) {
    await this.db.user.update({ where: { id }, data: { passwordHash, mustChangePassword: false } });
  }
  list() {
    return this.db.user.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  }
  async create(email: string, passwordHash: string) {
    try {
      return await this.db.user.create({ data: {
        email, passwordHash, role: 'user', isActive: true, mustChangePassword: true,
      } });
    } catch (error) {
      // The unique index also handles simultaneous requests for the same email.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new AppError(409, 'email already exists');
      }
      throw error;
    }
  }
  resetPassword(id: string, passwordHash: string) {
    return this.updateAccount(id, { passwordHash, mustChangePassword: true });
  }
  setActive(id: string, isActive: boolean) {
    return this.updateAccount(id, { isActive });
  }
  private async updateAccount(id: string, data: { passwordHash?: string; mustChangePassword?: boolean; isActive?: boolean }) {
    try {
      return await this.db.user.update({ where: { id }, data });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
        throw new AppError(404, 'user not found');
      }
      throw error;
    }
  }
}
