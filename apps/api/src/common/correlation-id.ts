import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '@acf/contracts';

/** Accept caller-supplied IDs only if they are short and log-safe. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

const correlationIds = new WeakMap<Request, string>();

export function resolveCorrelationId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}

/** Correlation ID assigned to this request by {@link correlationIdMiddleware}. */
export function getCorrelationId(req: Request): string | undefined {
  return correlationIds.get(req);
}

/** Express middleware: assigns a correlation ID and echoes it in the response header. */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveCorrelationId(req.header(CORRELATION_ID_HEADER));
  correlationIds.set(req, id);
  res.setHeader(CORRELATION_ID_HEADER, id);
  next();
}
