import { HttpException } from '@nestjs/common';

import type { ValidationIssue } from '@acf/contracts';

export interface ApiErrorOptions {
  readonly status: number;
  /** Stable machine-readable code (`ApiErrorCode`). */
  readonly code: string;
  /** User-safe message. Never include driver messages, SQL or secrets. */
  readonly message: string;
  /** Overrides the status-based default (e.g. a retryable 409). */
  readonly retryable?: boolean;
  readonly details?: readonly ValidationIssue[];
  /** The resource's current state, when the conflict depends on it. */
  readonly current?: unknown;
}

/** Body carried by {@link ApiError}; read by `ApiExceptionFilter`. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: readonly ValidationIssue[];
  readonly current?: unknown;
}

/** An HTTP error with an explicit API error code (docs/API_SPEC.md §11). */
export class ApiError extends HttpException {
  constructor(options: ApiErrorOptions, cause?: unknown) {
    const body: ApiErrorBody = {
      code: options.code,
      message: options.message,
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.current === undefined ? {} : { current: options.current }),
    };
    super(body, options.status, cause === undefined ? undefined : { cause });
  }
}
