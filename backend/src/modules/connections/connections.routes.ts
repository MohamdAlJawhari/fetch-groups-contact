import { Router, type RequestHandler } from 'express';
import type { ConnectionsController } from './connections.controller.js';

export function createConnectionsRoutes(controller: ConnectionsController, authenticate: RequestHandler, owned: RequestHandler) {
  const router = Router();
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(authenticate);
  router.post('/', controller.start);
  router.get('/:id', owned, controller.status);
  router.get('/:id/groups', owned, controller.groups);
  router.delete('/:id', owned, controller.disconnect);
  return router;
}
