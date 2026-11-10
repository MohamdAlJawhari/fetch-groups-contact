import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);
const passwordInput = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 72);
export const newPasswordSchema = passwordInput.refine(value => value.length >= 12,
  'Password must have at least 12 characters and at most 72 UTF-8 bytes');
export const loginSchema = z.object({ email: emailSchema, password: passwordInput });
export const changePasswordSchema = z.object({ currentPassword: passwordInput, newPassword: newPasswordSchema });
