import type { AuditAction } from '../../shared/types.js';
import type { AuditRepository } from './audit.repository.js';

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}
  record(userId: string, action: AuditAction, platform?: string, targetUserId?: string) {
    return this.repository.insert(userId, action, platform, targetUserId);
  }
}
