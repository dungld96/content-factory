import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApiErrorCode, type ApiErrorResponse, type ValidationIssue } from '@acf/contracts';
import { PostgresSqlState } from '@acf/database';

import { getCorrelationId } from './correlation-id.js';
import { mapDatabaseError } from './database-error.mapper.js';

const STATUS_TO_CODE: Readonly<Partial<Record<number, ApiErrorCode>>> = {
  [HttpStatus.BAD_REQUEST]: ApiErrorCode.BadRequest,
  [HttpStatus.UNAUTHORIZED]: ApiErrorCode.Unauthorized,
  [HttpStatus.PAYMENT_REQUIRED]: ApiErrorCode.PaymentRequired,
  [HttpStatus.FORBIDDEN]: ApiErrorCode.Forbidden,
  [HttpStatus.NOT_FOUND]: ApiErrorCode.NotFound,
  [HttpStatus.METHOD_NOT_ALLOWED]: ApiErrorCode.MethodNotAllowed,
  [HttpStatus.NOT_ACCEPTABLE]: ApiErrorCode.NotAcceptable,
  [HttpStatus.REQUEST_TIMEOUT]: ApiErrorCode.RequestTimeout,
  [HttpStatus.CONFLICT]: ApiErrorCode.Conflict,
  [HttpStatus.GONE]: ApiErrorCode.Gone,
  [HttpStatus.PRECONDITION_FAILED]: ApiErrorCode.PreconditionFailed,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ApiErrorCode.PayloadTooLarge,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ApiErrorCode.UnsupportedMediaType,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ApiErrorCode.ValidationFailed,
  [HttpStatus.PRECONDITION_REQUIRED]: ApiErrorCode.PreconditionRequired,
  [HttpStatus.TOO_MANY_REQUESTS]: ApiErrorCode.RateLimited,
  [HttpStatus.SERVICE_UNAVAILABLE]: ApiErrorCode.ServiceUnavailable,
};

const RETRYABLE_STATUSES = new Set<number>([
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.BAD_GATEWAY,
  HttpStatus.SERVICE_UNAVAILABLE,
  HttpStatus.GATEWAY_TIMEOUT,
]);

/** 5xx statuses whose message is intentionally user-facing (e.g. maintenance notices). */
const EXPOSE_MESSAGE_5XX = new Set<number>([HttpStatus.SERVICE_UNAVAILABLE]);

/** Domain exceptions can carry an explicit code via this shape in their response body. */
interface CodedBody {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  details?: unknown;
}

function isIssueList(value: unknown): value is ValidationIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['path'] === 'string' &&
        typeof (item as Record<string, unknown>)['message'] === 'string',
    )
  );
}

/**
 * Maps every thrown error to the envelope in docs/API_SPEC.md §10.
 * Unknown errors become a generic 500: no stack traces or internal messages leave the process.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(thrown: unknown, host: ArgumentsHost): void {
    let exception = thrown;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const correlationId = getCorrelationId(req) ?? 'unknown';

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ApiErrorCode.InternalError;
    let message = 'An unexpected error occurred.';
    let retryable: boolean | undefined;
    let details: ValidationIssue[] | undefined;

    if (!(exception instanceof HttpException)) {
      const mapped = mapDatabaseError(exception);
      if (mapped) {
        if (mapped.sqlState === PostgresSqlState.DEADLOCK_DETECTED) {
          // A deadlock on a protocol-following path is a defect (ADR-0011 §6): alert on it.
          this.logger.error({ msg: 'deadlock_detected', correlationId, sqlState: mapped.sqlState });
        }
        exception = mapped.error;
      }
    }

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code =
        STATUS_TO_CODE[status] ??
        (status >= 500 ? ApiErrorCode.InternalError : ApiErrorCode.ClientError);
      const body = exception.getResponse();
      if (typeof body === 'object') {
        const coded = body as CodedBody;
        if (typeof coded.code === 'string') code = coded.code;
        if (typeof coded.retryable === 'boolean') retryable = coded.retryable;
        if (isIssueList(coded.details)) details = coded.details;
        if (typeof coded.message === 'string') message = coded.message;
        else if (Array.isArray(coded.message)) message = coded.message.join('; ');
      } else if (typeof body === 'string') {
        message = body;
      }
      if (status >= 500 && !EXPOSE_MESSAGE_5XX.has(status)) {
        message = 'An unexpected error occurred.';
      }
    }

    if (status >= 500) {
      this.logger.error({
        msg: 'request_failed',
        correlationId,
        statusCode: status,
        errorName: exception instanceof Error ? exception.name : typeof exception,
        // Stack goes to server logs only; never to the client.
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    const payload: ApiErrorResponse = {
      error: {
        code,
        message,
        retryable: retryable ?? RETRYABLE_STATUSES.has(status),
        correlationId,
        ...(details ? { details } : {}),
      },
    };
    res.status(status).json(payload);
  }
}
