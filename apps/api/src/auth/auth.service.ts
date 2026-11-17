import { promisify } from 'node:util';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ApiEnv } from '@acf/config';
import {
  ApiErrorCode,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
} from '@acf/contracts';

import { ApiError } from '../common/api-error.js';
import { getCorrelationId } from '../common/correlation-id.js';
import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { Actor } from './actor.js';
import { CsrfService } from './csrf.service.js';
import { PasswordHasher } from './password-hasher.js';
import { PrismaSessionStore } from './session/prisma-session-store.js';
import { sessionCookieConfig } from './session/session-cookies.js';

/** Normalization applied before every email lookup or write (matches the users CHECK). */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const invalidCredentials = () =>
  new ApiError({
    status: HttpStatus.UNAUTHORIZED,
    code: ApiErrorCode.InvalidCredentials,
    message: 'The email or password is incorrect.',
  });

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly store: PrismaSessionStore,
    private readonly csrf: CsrfService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Design package §5.5 step 1. */
  async login(req: Request, res: Response, input: LoginRequest): Promise<LoginResponse> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: normalizeEmail(input.email) },
      select: { id: true, email: true, displayName: true, passwordHash: true, status: true },
    });
    // Unknown emails are verified against a dummy hash, so timing does not reveal accounts.
    // Disabled accounts get the same generic error.
    const passwordOk = user
      ? await this.hasher.verify(user.passwordHash, input.password)
      : await this.hasher.verifyDummy(input.password);
    if (!user || !passwordOk || user.status !== 'active') throw invalidCredentials();

    // Fixation defence: a brand-new session ID; the previous row (if any) is deleted.
    await promisify(req.session.regenerate.bind(req.session))();

    // Fail closed: express-session silently skips a Secure cookie on a non-HTTPS request
    // (proxy misconfiguration). Checked before any row is written.
    if (req.session.cookie.secure === true && !req.secure) {
      await promisify(req.session.destroy.bind(req.session))();
      this.logger.error({ msg: 'session_cookie_not_set', correlationId: getCorrelationId(req) });
      throw new ApiError({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ApiErrorCode.SessionCookieNotSet,
        message: 'Login failed.',
      });
    }

    req.session.userId = user.id;
    req.session.authenticatedAt = new Date().toISOString();
    await this.store.createForLogin(req.sessionID, req.session); // the only INSERT path

    const now = new Date();
    const rehash = this.hasher.needsRehash(user.passwordHash)
      ? { passwordHash: await this.hasher.hash(input.password) }
      : {};
    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, ...rehash },
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      csrfToken: this.csrf.generate(req, res),
    };
  }

  /** Design package §5.5 step 3: immediate revocation. */
  async logout(req: Request, res: Response): Promise<void> {
    await promisify(req.session.destroy.bind(req.session))();
    const cookies = sessionCookieConfig(this.env);
    res.clearCookie(cookies.sessionCookie, cookies.options);
    res.clearCookie(cookies.csrfCookie, cookies.options);
  }

  async me(actor: Actor): Promise<MeResponse> {
    const memberships = await this.prisma.client.projectMember.findMany({
      where: { userId: actor.userId, project: { archivedAt: null } },
      select: { role: true, project: { select: { id: true, slug: true, name: true } } },
      orderBy: { project: { name: 'asc' } },
    });
    return {
      user: actor.user,
      memberships: memberships.map((m) => ({
        projectId: m.project.id,
        projectSlug: m.project.slug,
        projectName: m.project.name,
        role: m.role,
      })),
    };
  }

  csrfToken(req: Request, res: Response): { csrfToken: string } {
    return { csrfToken: this.csrf.generate(req, res) };
  }
}
