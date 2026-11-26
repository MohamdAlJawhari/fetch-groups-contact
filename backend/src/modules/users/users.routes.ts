import { Router, type RequestHandler } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin.js';
import type { UsersController } from './users.controller.js';

export function createUsersRoutes(controller: UsersController, authenticate: RequestHandler) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(authenticate, requireAdmin);
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.post('/:id/reset-password', controller.resetPassword);
  router.post('/:id/enable', controller.setActive(true));
  router.post('/:id/disable', controller.setActive(false));
  router.delete('/:id', controller.remove);
  return router;
}
