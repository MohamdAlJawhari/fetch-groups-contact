import { Router, type RequestHandler } from 'express';
import type { AuthController } from './auth.controller.js';

export function createAuthRoutes(
  controller: AuthController,
  loginLimiter: RequestHandler,
  authenticateWithTemporaryPassword: RequestHandler,
) {
  const router = Router();
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/login', loginLimiter, controller.login);
  // T25: the frontend asks who is logged in on page load (the cookie is HttpOnly). Temporary passwords allowed.
  router.get('/me', authenticateWithTemporaryPassword, controller.me);
  router.post('/logout', authenticateWithTemporaryPassword, controller.logout);
  router.post('/change-password', authenticateWithTemporaryPassword, controller.changePassword);
  return router;
}
