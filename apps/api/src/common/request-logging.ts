import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { getCorrelationId } from './correlation-id.js';

/**
 * Logs one structured line per request. Logs the path without the query string and
 * never logs headers or bodies (they may carry credentials or prompt data).
 */
export function createRequestLoggingMiddleware(logger: LoggerService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.log(
        {
          msg: 'http_request',
          correlationId: getCorrelationId(req),
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
        },
        'Http',
      );
    });
    next();
  };
}
