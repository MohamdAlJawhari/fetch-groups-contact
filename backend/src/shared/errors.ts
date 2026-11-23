export class AppError extends Error {
  /** `groupIds` is the only extra error field (docs/specs/06-telegram.md 3.4): IDs the user sent, never titles. */
  constructor(public readonly status: number, message: string, public readonly groupIds?: readonly string[]) { super(message); }
}

export const LOGIN_FAILURE = 'wrong email or password';
