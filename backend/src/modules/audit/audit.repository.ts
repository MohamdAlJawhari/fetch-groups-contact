import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AuditAction } from '../../shared/types.js';

export interface AuditRepository {
  insert(userId: string, action: AuditAction, platform?: string, targetUserId?: string): Promise<void>;
}

export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly db: PrismaClient) {}
  async insert(userId: string, action: AuditAction, platform?: string, targetUserId?: string) {
    await this.db.auditLog.create({ data: { userId, action, platform, targetUserId } });
  }
}
