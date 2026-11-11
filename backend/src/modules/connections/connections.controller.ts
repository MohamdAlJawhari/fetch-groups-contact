import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { ConnectionsService } from './connections.service.js';

const startSchema = z.object({ platform: z.enum(['telegram', 'whatsapp']) }).strict();

export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}
  start = async (request: Request, response: Response) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'platform must be telegram or whatsapp');
    response.status(201).json(await this.connections.start(request.user!.id, parsed.data.platform, request.sessionId!));
  };
  status = async (request: Request, response: Response) => {
    response.json(await this.connections.status(request.user!.id, request.params.id as string));
  };
  groups = async (request: Request, response: Response) => {
    response.json({ groups: await this.connections.groups(request.user!.id, request.params.id as string) });
  };
  disconnect = async (request: Request, response: Response) => {
    await this.connections.disconnect(request.user!.id, request.params.id as string);
    response.status(204).end();
  };
}
