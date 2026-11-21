import { Inject, Injectable } from '@nestjs/common';
import { doubleCsrf, type DoubleCsrfUtilities } from 'csrf-csrf';
import type { Request, Response } from 'express';

import type { ApiEnv } from '@acf/config';
import { CSRF_HEADER } from '@acf/contracts';

import { API_ENV } from '../config/api-config.module.js';
import { sessionCookieConfig } from './session/session-cookies.js';

/**
 * Signed double-submit CSRF tokens bound to the session ID (csrf-csrf; design package §5.7).
 * A token is invalid after logout or re-login because the session ID changes.
 */
@Injectable()
export class CsrfService {
  private readonly csrf: DoubleCsrfUtilities;
  readonly cookieName: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    const cookies = sessionCookieConfig(env);
    this.cookieName = cookies.csrfCookie;
    this.csrf = doubleCsrf({
      getSecret: () => env.CSRF_SECRET,
      getSessionIdentifier: (req) => req.sessionID,
      cookieName: cookies.csrfCookie,
      cookieOptions: cookies.options,
      getCsrfTokenFromRequest: (req) => req.header(CSRF_HEADER),
    });
  }

  /** Issues a token for the current session and sets its cookie. */
  generate(req: Request, res: Response): string {
    return this.csrf.generateCsrfToken(req, res, { overwrite: true });
  }

  isValid(req: Request): boolean {
    return this.csrf.validateRequest(req);
  }
}
