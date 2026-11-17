import {
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { ApiEnv } from '@acf/config';
import { ApiErrorCode } from '@acf/contracts';

import { ApiError } from '../common/api-error.js';
import { API_ENV } from '../config/api-config.module.js';
import { setActor } from './actor.js';
import { CsrfService } from './csrf.service.js';
import { PUBLIC_METADATA, type PublicRule } from './public.decorator.js';
import { SessionUserService } from './session-user.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const unauthorized = () =>
  new ApiError({
    status: HttpStatus.UNAUTHORIZED,
    code: ApiErrorCode.Unauthorized,
    message: 'Authentication is required.',
  });

/**
 * Origin check (design §5.7): an unsafe request must carry an allowed `Origin`; without one,
 * `Sec-Fetch-Site: same-origin` is required. Protects login too, where no session exists yet.
 */
export function originAllowed(req: Request, allowed: readonly string[]): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.header('origin');
  if (origin !== undefined) return allowed.includes(origin);
  return req.header('sec-fetch-site') === 'same-origin';
}

/**
 * The single global guard, so the order is fixed: Origin (403) → session (401) → CSRF (403).
 * Request validation (400) runs afterwards, in an interceptor.
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
    private readonly sessionUsers: SessionUserService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();

    if (!originAllowed(req, this.env.WEB_ORIGINS)) {
      throw new ApiError({
        status: HttpStatus.FORBIDDEN,
        code: ApiErrorCode.OriginRejected,
        message: 'The request origin is not allowed.',
      });
    }

    const rule = this.reflector.getAllAndOverride<PublicRule | undefined>(PUBLIC_METADATA, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (rule === true || (typeof rule === 'function' && rule(this.env))) return true;

    const actor = await this.sessionUsers.resolve(req);
    if (!actor) throw unauthorized();
    setActor(req, actor);

    if (!SAFE_METHODS.has(req.method) && !this.csrf.isValid(req)) {
      throw new ApiError({
        status: HttpStatus.FORBIDDEN,
        code: ApiErrorCode.CsrfInvalid,
        message: 'The CSRF token is missing or invalid.',
      });
    }
    return true;
  }
}
