import { createParamDecorator, HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApiErrorCode } from '@acf/contracts';

import { ApiError } from '../api-error.js';

/**
 * Optimistic concurrency (decision D9, design package §8.4). The ETag of a mutable resource is
 * `W/"<updatedAt epoch-ms>"`. Services compare with a conditional
 * `UPDATE … WHERE id = $1 AND updated_at = $2` (0 rows → 412), which is race-free.
 */
export function etagFor(updatedAt: Date): string {
  return `W/"${updatedAt.getTime()}"`;
}

const ETAG = /^(?:W\/)?"(\d{1,16})"$/;

/**
 * Parses an `If-Match` header into the `updatedAt` it names.
 * - `undefined`: header absent.
 * - A single weak or strong ETag in our format: its timestamp.
 * @throws {ApiError} 412 for any other value (`*`, lists, foreign formats): they cannot match.
 */
export function parseIfMatch(header: string | undefined): Date | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const match = ETAG.exec(header.trim());
  if (!match?.[1]) throw preconditionFailed();
  return new Date(Number(match[1]));
}

export function preconditionFailed(): ApiError {
  return new ApiError({
    status: HttpStatus.PRECONDITION_FAILED,
    code: ApiErrorCode.PreconditionFailed,
    message: 'The resource has changed since you last read it.',
  });
}

export function preconditionRequired(): ApiError {
  return new ApiError({
    status: HttpStatus.PRECONDITION_REQUIRED,
    code: ApiErrorCode.PreconditionRequired,
    message: 'This request requires an If-Match header.',
  });
}

/** Express app setting holding env `REQUIRE_IF_MATCH` (set in `configureApp`). */
export const REQUIRE_IF_MATCH_SETTING = 'acf.requireIfMatch';

/** Resolves the expected `updatedAt` from `If-Match` (or `undefined` if absent and optional). */
export function expectedVersion(header: string | undefined, required: boolean): Date | undefined {
  const parsed = parseIfMatch(header);
  if (parsed === undefined && required) throw preconditionRequired();
  return parsed;
}

/** Route parameter: the `updatedAt` named by `If-Match`, honouring `REQUIRE_IF_MATCH`. */
export const IfMatch = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return expectedVersion(req.header('if-match'), req.app.get(REQUIRE_IF_MATCH_SETTING) === true);
});
