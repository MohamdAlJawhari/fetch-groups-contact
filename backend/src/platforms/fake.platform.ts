import type { CategorizedContacts, Platform, PlatformName, PlatformStatus } from './platform.types.js';

export interface FakePlatformOptions { now?: () => number; scanDelayMs?: number }

export class FakePlatform implements Platform {
  private connectedAt: number | undefined;
  private readonly now: () => number;
  private readonly scanDelayMs: number;
  constructor(private readonly name: PlatformName, options: FakePlatformOptions = {}) {
    this.now = options.now ?? Date.now;
    this.scanDelayMs = options.scanDelayMs ?? 3_000;
  }
  async connect() { this.connectedAt = this.now(); }
  async getStatus(): Promise<PlatformStatus> {
    if (this.connectedAt === undefined) return { status: 'disconnected' };
    if (this.now() - this.connectedAt < this.scanDelayMs) {
      return { status: 'waiting-for-scan', qr: `FAKE_QR:${this.name}:scan-placeholder` };
    }
    return { status: 'connected' };
  }
  async listGroups() {
    await this.requireConnected();
    return [{ id: 'sample-group-1', title: 'Sample team' }, { id: 'sample-group-2', title: 'Sample community' }];
  }
  async listContacts(groupIds: readonly string[]): Promise<CategorizedContacts> {
    const groups = await this.listGroups();
    if (!groupIds.length || groupIds.some(id => !groups.some(group => group.id === id))) {
      throw new Error('Select valid sample groups');
    }
    const saved = { category: 'saved' as const, contacts: [{ id: 'sample-saved', name: 'Sample saved contact', phoneNumber: '+12025550101' }] };
    if (this.name === 'whatsapp') return [saved, {
      category: 'unsaved', contacts: [{ id: 'sample-unsaved', name: 'Sample unsaved contact', phoneNumber: '+12025550102' }],
    }];
    return [saved,
      { category: 'unsaved_reachable', contacts: [{ id: 'sample-reachable', name: 'Sample reachable contact', username: 'sample_contact' }] },
      { category: 'unsaved_unreachable', contacts: [{ id: 'sample-unreachable', name: 'Sample unreachable contact' }] },
    ];
  }
  async disconnect() { this.connectedAt = undefined; }
  private async requireConnected() {
    if ((await this.getStatus()).status !== 'connected') throw new Error('Platform is not connected');
  }
}
