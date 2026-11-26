// Response shapes from docs/04-api.md.

export type Role = 'admin' | 'user';
export type PlatformName = 'telegram' | 'whatsapp';
export type ConnectionStatus = 'waiting-for-scan' | 'password-required' | 'connected' | 'disconnected';

/** GET /auth/me and POST /auth/login */
export interface SessionUser { id: string; email: string; role: Role; mustChangePassword: boolean }

/** /admin/users */
export interface AdminUser extends SessionUser { isActive: boolean; createdAt: string; lastLoginAt: string | null }
export interface UserWithTemporaryPassword { user: AdminUser; temporaryPassword: string }

/** POST /connections, GET /connections/:id, POST /connections/:id/password */
export interface ConnectionView { id: string; platform: PlatformName; status: ConnectionStatus; qr?: string; passwordHint?: string }

export interface Group { id: string; title: string }

export const MAX_GROUPS = 50;
