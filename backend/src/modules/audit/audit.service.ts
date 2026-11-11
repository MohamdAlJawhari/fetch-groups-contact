import type { AuditRepository } from './audit.repository.js';

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}
  record(userId: string, action: string, platform?: string, targetUserId?: string) {
    return this.repository.insert(userId, action, platform, targetUserId);
  }
}
