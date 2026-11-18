import { z } from 'zod';

/**
 * Stable, machine-readable API error codes. Extend per milestone; never reuse a code
 * for a different meaning.
 */
export const ApiErrorCode = {
  BadRequest: 'BAD_REQUEST',
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthorized: 'UNAUTHORIZED',
  PaymentRequired: 'PAYMENT_REQUIRED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  NotAcceptable: 'NOT_ACCEPTABLE',
  RequestTimeout: 'REQUEST_TIMEOUT',
  Conflict: 'CONFLICT',
  Gone: 'GONE',
  PreconditionFailed: 'PRECONDITION_FAILED',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  PreconditionRequired: 'PRECONDITION_REQUIRED',
  RateLimited: 'RATE_LIMITED',
  /** Any other 4xx without a dedicated code. */
  ClientError: 'CLIENT_ERROR',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalError: 'INTERNAL_ERROR',

  // --- M1: request handling ---
  /** Malformed pagination cursor. */
  InvalidCursor: 'INVALID_CURSOR',

  // --- M1: persistence (design package §8.3) ---
  SlugTaken: 'SLUG_TAKEN',
  EmailTaken: 'EMAIL_TAKEN',
  StorageKeyTaken: 'STORAGE_KEY_TAKEN',
  /** A referenced row does not exist, or belongs to another project (composite FK). */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  /** A database CHECK constraint rejected the write (the service should have validated it). */
  ConstraintViolation: 'CONSTRAINT_VIOLATION',
  VersionImmutable: 'VERSION_IMMUTABLE',
  VersionLinksFrozen: 'VERSION_LINKS_FROZEN',
  MasterConflict: 'MASTER_CONFLICT',
  AssetIdentityImmutable: 'ASSET_IDENTITY_IMMUTABLE',
  ArchiveOnly: 'ARCHIVE_ONLY',
  LastOwner: 'LAST_OWNER',
  AssetInUse: 'ASSET_IN_USE',
  AssetArchived: 'ASSET_ARCHIVED',
  /** A concurrent transaction changed the same rows; safe to retry. */
  ConcurrentModification: 'CONCURRENT_MODIFICATION',

  // --- M2: AI usage ledger (ADR-0012) ---
  /** Price and usage rows are append-only; an invocation's outcome is recorded once (AC011). */
  LedgerImmutable: 'LEDGER_IMMUTABLE',

  // --- M3: script and storyboard pipeline (design package §10) ---
  /** The brief has errors that block generation (details list them). */
  BriefInvalid: 'BRIEF_INVALID',
  /** No enabled, configured model is routed to (or given for) this task. */
  NoModelRoute: 'NO_MODEL_ROUTE',
  /** A generation of this kind is already queued or running for the content item. */
  GenerationInProgress: 'GENERATION_IN_PROGRESS',
  /** The content item's status does not allow this stage now. */
  InvalidPipelineState: 'INVALID_PIPELINE_STATE',
  /** Storyboards are generated only from the approved script (gate 1). */
  ScriptNotApproved: 'SCRIPT_NOT_APPROVED',
  /** The storyboard's script is no longer the approved script. */
  StaleStoryboard: 'STALE_STORYBOARD',
  /** The version was already reviewed; edits create new versions. */
  ArtifactImmutable: 'ARTIFACT_IMMUTABLE',
  /** Only queued or running work can be canceled. */
  NotCancelable: 'NOT_CANCELABLE',

  // --- M1: authentication (ADR-0009) ---
  /** Unknown email, wrong password or disabled account (deliberately indistinguishable). */
  InvalidCredentials: 'INVALID_CREDENTIALS',
  /** State-changing request without an allowed Origin / same-origin Sec-Fetch-Site. */
  OriginRejected: 'ORIGIN_REJECTED',
  /** Missing or invalid `x-csrf-token`. */
  CsrfInvalid: 'CSRF_INVALID',
  /** A Secure session cookie could not be set (proxy misconfiguration); login failed closed. */
  SessionCookieNotSet: 'SESSION_COOKIE_NOT_SET',

  // --- M1: workspace ---
  /** The resource (or its project/parent) is archived and therefore read-only. */
  Archived: 'ARCHIVED',
  /** No active user has the given email. */
  UserNotFound: 'USER_NOT_FOUND',
  /** The user is already a member of the project. */
  AlreadyMember: 'ALREADY_MEMBER',

  // --- M1: versions and assets (ADR-0010) ---
  /** The version is already approved (U5); `error.current` carries its state. */
  AlreadyApproved: 'ALREADY_APPROVED',
  /** The draft is numbered below the current master (U2): base a new draft on it instead. */
  StaleDraft: 'STALE_DRAFT',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** One field-level problem in a `VALIDATION_FAILED` response. */
export const validationIssueSchema = z.object({
  /** Dotted path into the request part, prefixed by the part: `body.email`, `query.limit`. */
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** Error envelope defined in docs/API_SPEC.md §10. */
export const apiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      correlationId: z.string(),
      /** Present on `VALIDATION_FAILED` only. */
      details: z.array(validationIssueSchema).optional(),
      /** The resource's current state, when the conflict depends on it (e.g. ALREADY_APPROVED). */
      current: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ApiErrorResponse' });
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const CORRELATION_ID_HEADER = 'x-correlation-id';
