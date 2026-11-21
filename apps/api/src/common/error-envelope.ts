import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ApiErrorResponse } from '@acf/contracts';

import { getCorrelationId } from './correlation-id.js';

const logger = new Logger('ErrorEnvelope');

/**
 * Writes the API error envelope from plain Express middleware (which runs outside Nest's
 * exception filters). Route handlers should throw instead.
 */
export function writeErrorEnvelope(
  req: Request,
  res: Response,
  error: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  },
): void {
  const correlationId = getCorrelationId(req) ?? 'unknown';
  if (error.status >= 500) {
    logger.error({
      msg: 'middleware_failed',
      correlationId,
      code: error.code,
      errorName: error.cause instanceof Error ? error.cause.name : typeof error.cause,
      stack: error.cause instanceof Error ? error.cause.stack : undefined,
    });
  }
  const body: ApiErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId,
    },
  };
  res.status(error.status).json(body);
}
