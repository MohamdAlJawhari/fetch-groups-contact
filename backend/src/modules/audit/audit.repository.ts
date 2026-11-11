import type { PrismaClient } from '../../generated/prisma/client.js';

export interface AuditRepository {
  insert(userId: string, action: string, platform?: string, targetUserId?: string): Promise<void>;
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: PrismaClient) {}
  async insert(userId: string, action: string, platform?: string, targetUserId?: string) {
    await this.db.auditLog.create({ data: { userId, action, platform, targetUserId } });
  }
}
