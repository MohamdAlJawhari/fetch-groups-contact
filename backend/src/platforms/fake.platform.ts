import { PlatformError } from './platform.errors.js';
import type { CategorizedContacts, Platform, PlatformName, PlatformStatus } from './platform.types.js';

export interface FakePlatformOptions {
  now?: () => number;
  scanDelayMs?: number;
  /** Simulates two-step verification: after the scan, `password-required` until this password is submitted. */
  password?: string;
  passwordHint?: string;
}

export class FakePlatform implements Platform {
  private connectedAt: number | undefined;
  private passwordAccepted = false;
  private readonly now: () => number;
  private readonly scanDelayMs: number;
  constructor(private readonly name: PlatformName, private readonly options: FakePlatformOptions = {}) {
    this.now = options.now ?? Date.now;
    this.scanDelayMs = options.scanDelayMs ?? 3_000;
  }
  async connect() { this.connectedAt = this.now(); this.passwordAccepted = false; }
  async getStatus(): Promise<PlatformStatus> {
    if (this.connectedAt === undefined) return { status: 'disconnected' };
    if (this.now() - this.connectedAt < this.scanDelayMs) {
      return { status: 'waiting-for-scan', qr: `FAKE_QR:${this.name}:scan-placeholder` };
    }
    if (this.options.password !== undefined && !this.passwordAccepted) {
      return this.options.passwordHint ? { status: 'password-required', passwordHint: this.options.passwordHint } : { status: 'password-required' };
    }
    return { status: 'connected' };
  }
  async submitPassword(password: string) {
    if ((await this.getStatus()).status !== 'password-required') throw new Error('Platform is not waiting for a password');
    if (password !== this.options.password) throw new PlatformError('wrong_password');
    this.passwordAccepted = true;
  }
  async listGroups() {
    await this.requireConnected();
    return [{ id: 'sample-group-1', title: 'Sample team', memberCount: 3 }, { id: 'sample-group-2', title: 'Sample community', memberCount: 3 }];
  }
  async listContacts(groupIds: readonly string[]): Promise<CategorizedContacts> {
    const groups = await this.listGroups();
    if (!groupIds.length || groupIds.some(id => !groups.some(group => group.id === id))) {
      throw new Error('Select valid sample groups');
    }
    const saved = { category: 'saved' as const, contacts: [{ id: 'sample-saved', name: 'Sample saved contact', phoneNumber: '+12025550101' }] };
    // Both platforms export 3 categories (docs/specs/08-whatsapp.md: hidden WhatsApp numbers make "unreachable" real).
    if (this.name === 'whatsapp') return [saved,
      { category: 'unsaved_reachable', contacts: [{ id: 'sample-unsaved', name: 'Sample unsaved contact', phoneNumber: '+12025550102' }] },
      { category: 'unsaved_unreachable', contacts: [{ id: 'sample-hidden', name: 'Sample hidden-number contact' }] },
    ];
    return [saved,
      { category: 'unsaved_reachable', contacts: [{ id: 'sample-reachable', name: 'Sample reachable contact', username: 'sample_contact' }] },
      { category: 'unsaved_unreachable', contacts: [{ id: 'sample-unreachable', name: 'Sample unreachable contact' }] },
    ];
  }
  async disconnect() { this.connectedAt = undefined; this.passwordAccepted = false; }
  private async requireConnected() {
    if ((await this.getStatus()).status !== 'connected') throw new Error('Platform is not connected');
  }
}
