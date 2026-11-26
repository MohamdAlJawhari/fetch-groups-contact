import type { Request, Response } from 'express';
import { z } from 'zod';
import { contentDisposition } from '../../export/export.filename.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionsService, ExportJob } from './connections.service.js';

const startSchema = z.object({ platform: z.enum(['telegram', 'whatsapp']) }).strict();
const exportSchema = z.object({
  groupIds: z.array(z.string().min(1).max(256)).min(1).max(50).refine(ids => new Set(ids).size === ids.length),
  files: z.enum(['merged', 'separate']).optional(),
}).strict();
const passwordSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const emptyBodySchema = z.object({}).strict().optional();
const CONTENT_TYPES = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' } as const;

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
  password = async (request: Request, response: Response) => {
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'password is required');
    response.json(await this.connections.submitPassword(request.user!.id, request.params.id as string, parsed.data.password));
  };
  groups = async (request: Request, response: Response) => {
    response.json({ groups: await this.connections.groups(request.user!.id, request.params.id as string) });
  };
  export = async (request: Request, response: Response) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'select between 1 and 50 groups');
    // Errors up to here are normal JSON responses; after the headers, job.write handles failures itself.
    const job = await this.connections.export(request.user!.id, request.params.id as string, parsed.data.groupIds, parsed.data.files);
    await this.download(response, job, 'contacts');
  };
  /** docs/specs/09-phone-contacts.md: no body, or `{}`. */
  exportContacts = async (request: Request, response: Response) => {
    if (!emptyBodySchema.safeParse(request.body).success) throw new AppError(400, 'this request takes no body');
    const job = await this.connections.exportAddressBook(request.user!.id, request.params.id as string);
    await this.download(response, job, 'phone-contacts');
  };
  private async download(response: Response, job: ExportJob, asciiPrefix: string) {
    const date = job.startedAt.toISOString().slice(0, 10);
    response.status(200);
    response.setHeader('Content-Type', CONTENT_TYPES[job.kind]);
    // The real name (it may hold an Arabic group title) is in filename*; the ASCII one is for old clients.
    response.setHeader('Content-Disposition', contentDisposition(job.filename, `${asciiPrefix}-${job.platform}-${date}.${job.kind}`));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    await job.write(response);
  }
  disconnect = async (request: Request, response: Response) => {
    await this.connections.disconnect(request.user!.id, request.params.id as string);
    response.status(204).end();
  };
}
