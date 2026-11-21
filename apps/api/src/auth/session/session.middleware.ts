import type { NextFunction, Request, RequestHandler, Response } from 'express';
import session from 'express-session';

import type { ApiEnv } from '@acf/config';
import { ApiErrorCode } from '@acf/contracts';

import { writeErrorEnvelope } from '../../common/error-envelope.js';
import type { PrismaSessionStore } from './prisma-session-store.js';
import { sessionCookieConfig } from './session-cookies.js';

/**
 * express-session owns ID generation (192-bit), cookie signing with rotatable secrets,
 * `regenerate`, `destroy` and the rolling cookie (design package §5.4).
 * Store failures answer `503` in the API error envelope instead of Express's HTML page.
 */
export function createSessionMiddleware(env: ApiEnv, store: PrismaSessionStore): RequestHandler {
  const cookies = sessionCookieConfig(env);
  const middleware = session({
    name: cookies.sessionCookie,
    secret: env.SESSION_SECRETS,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    cookie: { ...cookies.options, maxAge: env.SESSION_IDLE_TTL_MS },
  });
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (error?: unknown) => {
      if (error) {
        writeErrorEnvelope(req, res, {
          status: 503,
          code: ApiErrorCode.ServiceUnavailable,
          message: 'The service is temporarily unavailable.',
          retryable: true,
          cause: error,
        });
        return;
      }
      next();
    });
  };
}
