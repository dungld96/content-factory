import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode } from '@acf/contracts';

import { ApiError } from './api-error.js';
import { preconditionFailed } from './http/etag.js';

/** 404 for missing rows and for projects the caller is not a member of (decision D7). */
export const notFound = (what = 'resource') =>
  new ApiError({
    status: HttpStatus.NOT_FOUND,
    code: ApiErrorCode.NotFound,
    message: `The ${what} does not exist.`,
  });

export const forbidden = () =>
  new ApiError({
    status: HttpStatus.FORBIDDEN,
    code: ApiErrorCode.Forbidden,
    message: 'Your role in this project does not allow this action.',
  });

export const archived = (what = 'resource') =>
  new ApiError({
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.Archived,
    message: `The ${what} is archived and read-only.`,
  });

export const referenceNotFound = (what: string) =>
  new ApiError({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.ReferenceNotFound,
    message: `The ${what} does not exist in this project.`,
  });

/**
 * Explains why a guarded `updateMany(where: { id, archivedAt: null, updatedAt? })` matched no
 * row, from a fresh read of that row: gone (404), archived (409) or changed since the caller's
 * `If-Match` (412). The conditional update itself is race-free (design package §8.4).
 */
export function guardedUpdateFailure(
  current: { readonly archivedAt: Date | null } | null,
  what: string,
): ApiError {
  if (!current) return notFound(what);
  if (current.archivedAt) return archived(what);
  return preconditionFailed();
}
