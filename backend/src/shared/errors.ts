export class AppError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export const LOGIN_FAILURE = 'wrong email or password';
