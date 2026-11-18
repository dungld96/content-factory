/**
 * Stable SQLSTATEs raised by the integrity layer (migrations `init_m1`, ADR-0011 §4, and
 * `m2_ai_registry`, ADR-0012; `m3_script_storyboard`, ADR-0013).
 * The API maps these to error codes (design package §8.3). Messages are for operators only.
 */
export const IntegritySqlState = {
  APPROVED_VERSION_IMMUTABLE: 'AC001',
  APPROVED_VERSION_LINKS_FROZEN: 'AC002',
  INVALID_MASTER_POINTER: 'AC003',
  APPROVAL_WITHOUT_MASTER: 'AC004',
  ASSET_IDENTITY_IMMUTABLE: 'AC005',
  HARD_DELETE_FORBIDDEN: 'AC006',
  PROJECT_WITHOUT_OWNER: 'AC007',
  ASSET_IN_USE: 'AC008',
  VERSION_NOT_DRAFT_ON_INSERT: 'AC009',
  APPROVAL_WITH_ARCHIVED_ASSET: 'AC010',
  /** M2 (ADR-0012): prices and usage are append-only; invocations get one outcome. */
  LEDGER_ROW_IMMUTABLE: 'AC011',
  /** M3: script/storyboard versions, scenes and scene assets are immutable after review. */
  ARTIFACT_IMMUTABLE: 'AC012',
  /** M3: approval pointers reference approved versions; a stale storyboard cannot be approved. */
  ARTIFACT_POINTER_INVALID: 'AC013',
} as const;
export type IntegritySqlState = (typeof IntegritySqlState)[keyof typeof IntegritySqlState];

/** Standard PostgreSQL SQLSTATEs the application handles explicitly. */
export const PostgresSqlState = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export interface DatabaseErrorInfo {
  /** Five-character PostgreSQL SQLSTATE, e.g. `AC001` or `23505`. */
  readonly sqlState: string;
  /** Violated constraint or index name, when PostgreSQL/Prisma reports it. */
  readonly constraint?: string;
  /** Operator-facing message. Never return it to API clients verbatim. */
  readonly message?: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const SQLSTATE = /^[0-9A-Z]{5}$/;

function fromDriverCause(cause: unknown): DatabaseErrorInfo | undefined {
  if (!isRecord(cause)) return undefined;
  const code = cause['originalCode'];
  if (typeof code !== 'string' || !SQLSTATE.test(code)) return undefined;
  const constraint = isRecord(cause['constraint']) ? cause['constraint']['index'] : undefined;
  const message = cause['originalMessage'];
  return {
    sqlState: code,
    ...(typeof constraint === 'string' ? { constraint } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

/**
 * Extracts the PostgreSQL SQLSTATE from an error thrown by Prisma 7 + `@prisma/adapter-pg`
 * or by the `pg` driver. Verified shapes (see `test/prisma-errors.integration.test.ts`):
 *
 * - Model and raw operations: `PrismaClientKnownRequestError` with
 *   `meta.driverAdapterError.cause.originalCode`.
 * - Deferred constraint triggers raised at COMMIT of an interactive transaction: a bare
 *   `DriverAdapterError` with `cause.originalCode`.
 * - `pg` errors: `code` (and `constraint`).
 *
 * Returns `undefined` for anything else (connection errors, application errors).
 */
export function databaseErrorInfo(error: unknown): DatabaseErrorInfo | undefined {
  if (!isRecord(error)) return undefined;
  const meta = error['meta'];
  if (isRecord(meta) && isRecord(meta['driverAdapterError'])) {
    const info = fromDriverCause(meta['driverAdapterError']['cause']);
    if (info) return info;
  }
  if (error['name'] === 'DriverAdapterError') {
    const info = fromDriverCause(error['cause']);
    if (info) return info;
  }
  // Prisma's own codes (e.g. P2025) look like SQLSTATEs but are not.
  const name = error['name'];
  if (typeof name === 'string' && name.startsWith('PrismaClient')) return undefined;
  const code = error['code'];
  if (typeof code === 'string' && SQLSTATE.test(code)) {
    const constraint = error['constraint'];
    const message = error['message'];
    return {
      sqlState: code,
      ...(typeof constraint === 'string' ? { constraint } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  }
  return undefined;
}
