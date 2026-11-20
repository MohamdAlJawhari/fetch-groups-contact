export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
}

/** Every action name the audit log may record. Add new actions here first. */
export type AuditAction =
  | 'login'
  | 'logout'
  | 'password_changed'
  | 'admin_user_created'
  | 'admin_password_reset'
  | 'admin_user_disabled'
  | 'admin_user_enabled'
  | 'connection_started'
  | 'connection_ended'
  | 'export_started'
  | 'export_finished'
  | 'export_failed';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      sessionId?: string;
    }
  }
}
