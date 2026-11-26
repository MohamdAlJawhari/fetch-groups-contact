import type { Request, Response } from 'express';
import { z } from 'zod';
import { emailSchema } from '../auth/auth.validation.js';
import { AppError } from '../../shared/errors.js';
import type { UsersService } from './users.service.js';

const createUserSchema = z.object({ email: emailSchema }).strict();
const idSchema = z.string().uuid();

export class UsersController {
  constructor(private readonly users: UsersService) {}
  private userId(request: Request) {
    const parsed = idSchema.safeParse(request.params.id);
    if (!parsed.success) throw new AppError(400, 'invalid user id');
    return parsed.data;
  }
  list = async (request: Request, response: Response) => {
    response.json({ users: await this.users.list() });
  };
  create = async (request: Request, response: Response) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'provide only a valid email');
    response.status(201).json(await this.users.create(request.user!.id, parsed.data.email));
  };
  resetPassword = async (request: Request, response: Response) => {
    response.json(await this.users.resetPassword(request.user!.id, this.userId(request)));
  };
  setActive = (isActive: boolean) => async (request: Request, response: Response) => {
    response.json({ user: await this.users.setActive(request.user!.id, this.userId(request), isActive) });
  };
  remove = async (request: Request, response: Response) => {
    await this.users.remove(request.user!.id, this.userId(request));
    response.status(204).end();
  };
}
