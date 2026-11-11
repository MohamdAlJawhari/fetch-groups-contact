import type { CookieOptions, Request, Response } from 'express';
import { AppError, LOGIN_FAILURE } from '../../shared/errors.js';
import type { AuthService } from './auth.service.js';
import { SESSION_COOKIE, SESSION_TTL_MS } from './session.store.js';
import { changePasswordSchema, loginSchema, PASSWORD_REQUIREMENTS } from './auth.validation.js';

export class AuthController {
  private readonly cookieOptions: CookieOptions;
  constructor(private readonly auth: AuthService, production: boolean) {
    this.cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production, path: '/', signed: true };
  }
  login = async (request: Request, response: Response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(401, LOGIN_FAILURE);
    const previousId = request.signedCookies?.[SESSION_COOKIE];
    const result = await this.auth.login(parsed.data.email, parsed.data.password,
      typeof previousId === 'string' ? previousId : undefined);
    response.cookie(SESSION_COOKIE, result.sessionId, { ...this.cookieOptions, maxAge: SESSION_TTL_MS });
    response.json({ user: result.user });
  };
  logout = async (request: Request, response: Response) => {
    response.clearCookie(SESSION_COOKIE, this.cookieOptions);
    await this.auth.logout(request.sessionId!, request.user!.id);
    response.json({ message: 'logged out' });
  };
  changePassword = async (request: Request, response: Response) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, `provide currentPassword and newPassword. ${PASSWORD_REQUIREMENTS}`);
    }
    await this.auth.changePassword(request.user!.id, parsed.data.currentPassword, parsed.data.newPassword);
    response.clearCookie(SESSION_COOKIE, this.cookieOptions);
    response.json({ message: 'password changed; please log in again' });
  };
}
