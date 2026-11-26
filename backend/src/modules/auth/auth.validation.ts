import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);
const MAX_PASSWORD_BYTES = 72; // bcrypt's input limit
const MIN_PASSWORD_CHARS = 10;
const fitsBcrypt = (value: string) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES;
const passwordInput = z.string().min(1).refine(fitsBcrypt);

/** For admins and the CLI; users see the plain messages below instead. */
export const PASSWORD_REQUIREMENTS = 'Password must have at least 10 characters and at most 72 UTF-8 bytes';
// Plain words for non-technical users (the user's request, 2026-11-26).
export const PASSWORD_TOO_SHORT = 'the new password must be at least 10 characters long';
export const PASSWORD_TOO_LONG = 'the new password is too long. Please use a shorter one';
export const PASSWORDS_MISSING = 'please enter your current password and a new password';

/** Why a new password is refused, in plain words, or undefined when it's fine. */
export function newPasswordProblem(value: string): string | undefined {
  if (Array.from(value).length < MIN_PASSWORD_CHARS) return PASSWORD_TOO_SHORT;
  if (!fitsBcrypt(value)) return PASSWORD_TOO_LONG;
  return undefined;
}

export const newPasswordSchema = passwordInput.refine(value => Array.from(value).length >= MIN_PASSWORD_CHARS, PASSWORD_REQUIREMENTS);
export const loginSchema = z.object({ email: emailSchema, password: passwordInput });
/** The shape only; the controller turns failures into the plain messages above. */
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });
