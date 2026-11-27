import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { PrismaService } from '../infrastructure/prisma.service.js';
import type { Actor } from './actor.js';

import './session/session.types.js';

/** Resolves the session's user from the database on every request (design package §5.5). */
@Injectable()
export class SessionUserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The active user of this request's session, or `null`. A session whose user is missing or
   * disabled is destroyed, so its cookie stops working immediately.
   */
  async resolve(req: Request): Promise<Actor | null> {
    const userId = req.session.userId;
    if (!userId) return null;
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, status: true },
    });
    if (user?.status !== 'active') {
      await promisify(req.session.destroy.bind(req.session))();
      return null;
    }
    return {
      userId: user.id,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
}
