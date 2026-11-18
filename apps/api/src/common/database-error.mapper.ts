import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode } from '@acf/contracts';
import { databaseErrorInfo, IntegritySqlState, PostgresSqlState } from '@acf/database';

import { ApiError } from './api-error.js';

interface Mapping {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

const CONFLICT = HttpStatus.CONFLICT;

/** Integrity-layer SQLSTATEs (ADR-0011 §4) → API errors (design package §8.3). */
const SQLSTATE_MAP: Readonly<Record<string, Mapping>> = {
  [IntegritySqlState.APPROVED_VERSION_IMMUTABLE]: {
    status: CONFLICT,
    code: ApiErrorCode.VersionImmutable,
    message: 'This version is approved and cannot be changed.',
  },
  [IntegritySqlState.VERSION_NOT_DRAFT_ON_INSERT]: {
    status: CONFLICT,
    code: ApiErrorCode.VersionImmutable,
    message: 'Versions must be created as drafts.',
  },
  [IntegritySqlState.APPROVED_VERSION_LINKS_FROZEN]: {
    status: CONFLICT,
    code: ApiErrorCode.VersionLinksFrozen,
    message: 'The assets of an approved version cannot be changed.',
  },
  [IntegritySqlState.INVALID_MASTER_POINTER]: {
    status: CONFLICT,
    code: ApiErrorCode.MasterConflict,
    message: 'The master version changed concurrently.',
  },
  [IntegritySqlState.APPROVAL_WITHOUT_MASTER]: {
    status: CONFLICT,
    code: ApiErrorCode.MasterConflict,
    message: 'The master version changed concurrently.',
  },
  [IntegritySqlState.ASSET_IDENTITY_IMMUTABLE]: {
    status: CONFLICT,
    code: ApiErrorCode.AssetIdentityImmutable,
    message: 'The file identity of an asset cannot be changed.',
  },
  [IntegritySqlState.HARD_DELETE_FORBIDDEN]: {
    status: CONFLICT,
    code: ApiErrorCode.ArchiveOnly,
    message: 'This resource cannot be deleted; archive it instead.',
  },
  [IntegritySqlState.PROJECT_WITHOUT_OWNER]: {
    status: CONFLICT,
    code: ApiErrorCode.LastOwner,
    message: 'A project must keep at least one owner.',
  },
  [IntegritySqlState.ASSET_IN_USE]: {
    status: CONFLICT,
    code: ApiErrorCode.AssetInUse,
    message: 'The asset is used by an approved version.',
  },
  [IntegritySqlState.APPROVAL_WITH_ARCHIVED_ASSET]: {
    status: CONFLICT,
    code: ApiErrorCode.AssetArchived,
    message: 'The version references an archived asset.',
  },
  [IntegritySqlState.ARTIFACT_IMMUTABLE]: {
    status: CONFLICT,
    code: ApiErrorCode.ArtifactImmutable,
    message: 'This version was already reviewed; edits create a new version.',
  },
  [IntegritySqlState.ARTIFACT_POINTER_INVALID]: {
    status: CONFLICT,
    code: ApiErrorCode.StaleStoryboard,
    message: "The storyboard's script is no longer the approved script.",
  },
  [IntegritySqlState.CONTENT_MASTER_LINK_IMMUTABLE]: {
    status: CONFLICT,
    code: ApiErrorCode.ContentMasterImmutable,
    message: 'A content item cannot move to another content master.',
  },
  [IntegritySqlState.LEDGER_ROW_IMMUTABLE]: {
    status: CONFLICT,
    code: ApiErrorCode.LedgerImmutable,
    message: 'AI usage records cannot be changed.',
  },
  [PostgresSqlState.FOREIGN_KEY_VIOLATION]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.ReferenceNotFound,
    message: 'A referenced resource does not exist in this project.',
  },
  [PostgresSqlState.CHECK_VIOLATION]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.ConstraintViolation,
    message: 'The request violates a data constraint.',
  },
  [PostgresSqlState.SERIALIZATION_FAILURE]: {
    status: CONFLICT,
    code: ApiErrorCode.ConcurrentModification,
    message: 'The resource was modified concurrently. Retry the request.',
    retryable: true,
  },
  [PostgresSqlState.DEADLOCK_DETECTED]: {
    status: CONFLICT,
    code: ApiErrorCode.ConcurrentModification,
    message: 'The resource was modified concurrently. Retry the request.',
    retryable: true,
  },
};

/** Unique constraints/indexes → specific conflict codes. Others map to `CONFLICT`. */
function uniqueViolation(constraint: string | undefined): Mapping {
  if (constraint === 'users_email_key') {
    return { status: CONFLICT, code: ApiErrorCode.EmailTaken, message: 'The email is taken.' };
  }
  if (constraint === 'assets_storage_key_key') {
    return {
      status: CONFLICT,
      code: ApiErrorCode.StorageKeyTaken,
      message: 'The storage key is already registered.',
    };
  }
  if (constraint?.endsWith('slug_key')) {
    return { status: CONFLICT, code: ApiErrorCode.SlugTaken, message: 'The slug is taken.' };
  }
  return { status: CONFLICT, code: ApiErrorCode.Conflict, message: 'The resource already exists.' };
}

export interface MappedDatabaseError {
  readonly error: ApiError;
  readonly sqlState: string;
}

/**
 * Maps a database error (Prisma or `pg`) to an {@link ApiError}, or returns `undefined` when
 * the error is not a recognised database condition (it then becomes a 500).
 * Services pre-check every rule; this mapping is the backstop for races and direct SQL.
 */
export function mapDatabaseError(error: unknown): MappedDatabaseError | undefined {
  const info = databaseErrorInfo(error);
  if (!info) return undefined;
  const mapping =
    info.sqlState === PostgresSqlState.UNIQUE_VIOLATION
      ? uniqueViolation(info.constraint)
      : SQLSTATE_MAP[info.sqlState];
  if (!mapping) return undefined;
  return { error: new ApiError(mapping, error), sqlState: info.sqlState };
}
