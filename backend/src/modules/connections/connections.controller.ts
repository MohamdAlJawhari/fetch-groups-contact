import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { ConnectionsService } from './connections.service.js';

const startSchema = z.object({ platform: z.enum(['telegram', 'whatsapp']) }).strict();
const exportSchema = z.object({
  groupIds: z.array(z.string().min(1).max(256)).min(1).max(50).refine(ids => new Set(ids).size === ids.length),
}).strict();
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
  export = async (request: Request, response: Response) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'select between 1 and 50 groups');
    // Errors up to here are normal JSON responses; after the headers, job.write handles failures itself.
    const job = await this.connections.export(request.user!.id, request.params.id as string, parsed.data.groupIds);
    const date = job.startedAt.toISOString().slice(0, 10);
    response.status(200);
    response.setHeader('Content-Type', XLSX);
    response.setHeader('Content-Disposition', `attachment; filename="contacts-${job.platform}-${date}.xlsx"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    await job.write(response);
  };
  disconnect = async (request: Request, response: Response) => {
    await this.connections.disconnect(request.user!.id, request.params.id as string);
    response.status(204).end();
  };
}
