import type { PrismaClient, User } from '../../generated/prisma/client.js';

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  setLastLogin(id: string): Promise<void>;
  changePassword(id: string, passwordHash: string): Promise<void>;
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: PrismaClient) {}
  findByEmail(email: string) { return this.db.user.findUnique({ where: { email } }); }
  findById(id: string) { return this.db.user.findUnique({ where: { id } }); }
  async setLastLogin(id: string) {
    await this.db.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }
  async changePassword(id: string, passwordHash: string) {
    await this.db.user.update({ where: { id }, data: { passwordHash, mustChangePassword: false } });
  }
}
