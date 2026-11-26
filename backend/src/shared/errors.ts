export class AppError extends Error {
  /** `groupIds` is the only extra error field (docs/specs/06-telegram.md 3.4): IDs the user sent, never titles. */
  constructor(public readonly status: number, message: string, public readonly groupIds?: readonly string[]) { super(message); }
}

export const LOGIN_FAILURE = 'wrong email or password';
/** Sent only when the password was right (auth.service.ts), so it reveals nothing to someone guessing. */
export const ACCOUNT_DISABLED = 'this account is disabled. Please contact your admin';
