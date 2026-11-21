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

  // --- M4: object storage and images (M4 design package §4, §7) ---
  /** Object storage is not configured on this deployment (S3_* variables unset). */
  StorageNotConfigured: 'STORAGE_NOT_CONFIGURED',
  /** Object storage could not be reached; safe to retry. */
  StorageUnavailable: 'STORAGE_UNAVAILABLE',
  /** Only PNG, JPEG and WebP images are accepted (decided by the file's bytes). */
  UnsupportedMedia: 'UNSUPPORTED_MEDIA',
  /** The file or image dimensions exceed the limits. */
  MediaTooLarge: 'MEDIA_TOO_LARGE',
  /** The file is empty or its image header cannot be read. */
  MediaInvalid: 'MEDIA_INVALID',
  /** The declared Content-Type differs from the file's actual type. */
  MediaTypeMismatch: 'MEDIA_TYPE_MISMATCH',
  /** The asset is registered but its bytes are not in storage (e.g. M1 metadata-only assets). */
  AssetContentMissing: 'ASSET_CONTENT_MISSING',
  /** Images are generated only for the approved storyboard (gate 2). */
  StoryboardNotApproved: 'STORYBOARD_NOT_APPROVED',
  /** The cost cannot be estimated; resend with `acceptUnknownCost: true` to proceed. */
  UnknownCostNotAccepted: 'UNKNOWN_COST_NOT_ACCEPTED',
  /** The scene needs more reference images than the model accepts. */
  ReferencesExceedModelLimit: 'REFERENCES_EXCEED_MODEL_LIMIT',
  /** The model does not support the requested resolution, aspect ratio or seed. */
  ModelLimits: 'MODEL_LIMITS',
  /** A reference image is registered but its file is not stored. */
  ReferenceFileMissing: 'REFERENCE_FILE_MISSING',
  /** A keyframe must be an approved, active image of the scene's content item (AC015). */
  KeyframeInvalid: 'KEYFRAME_INVALID',
  SceneSelectionInvalid: 'SCENE_SELECTION_INVALID',
  KeyframeRequired: 'KEYFRAME_REQUIRED',
  ExceedsModelMaximum: 'EXCEEDS_MODEL_MAXIMUM',
  EstimateChanged: 'ESTIMATE_CHANGED',
  VoiceProfileRequired: 'VOICE_PROFILE_REQUIRED',
  ClipInvalid: 'CLIP_INVALID',
  VoiceoverInvalid: 'VOICEOVER_INVALID',
  JobNotRecheckable: 'JOB_NOT_RECHECKABLE',
  ClipsIncomplete: 'CLIPS_INCOMPLETE',
  BudgetExceeded: 'BUDGET_EXCEEDED',
  BudgetConfirmationRequired: 'BUDGET_CONFIRMATION_REQUIRED',
  NothingToResume: 'NOTHING_TO_RESUME',
  ReservationNotHeld: 'RESERVATION_NOT_HELD',
  VoiceoversIncomplete: 'VOICEOVERS_INCOMPLETE',
  VoiceoverExceedsScene: 'VOICEOVER_EXCEEDS_SCENE',
  MusicInvalid: 'MUSIC_INVALID',
  RenderInProgress: 'RENDER_IN_PROGRESS',
  RenderNotApproved: 'RENDER_NOT_APPROVED',
  RenderNotReviewable: 'RENDER_NOT_REVIEWABLE',

  // --- M5a: media tools, audio upload, ranges (M5 design package §7.3, §8) ---
  /** FFprobe/FFmpeg is not installed on this deployment. */
  MediaToolsMissing: 'MEDIA_TOOLS_MISSING',
  /** Music uploads need a licence note (source and terms of use). */
  LicenseNoteRequired: 'LICENSE_NOTE_REQUIRED',
  /** The requested byte range is outside the file. */
  RangeNotSatisfiable: 'RANGE_NOT_SATISFIABLE',
  /** Only images and references can be reviewed. */
  AssetNotReviewable: 'ASSET_NOT_REVIEWABLE',
  // --- P2a: asset metadata the platform writes is immutable (design A2) ---
  /** The request sets a metadata key reserved for the platform (`SYSTEM_METADATA_KEYS`). */
  MetadataKeyReserved: 'METADATA_KEY_RESERVED',
  // --- P1: operator settings ---
  /** The model cannot serve the task: capability missing, or model/provider disabled or unconfigured. */
  ModelNotRoutable: 'MODEL_NOT_ROUTABLE',
  // --- P2b: bindings to Library assets ---
  /** A scene reference is not an active, non-rejected reference or image of the project. */
  ReferenceInvalid: 'REFERENCE_INVALID',

  // --- R0: content masters and variants (ADR-0015) ---
  /** The format cannot be published on the target platform. */
  FormatPlatformIncompatible: 'FORMAT_PLATFORM_INCOMPATIBLE',
  /** `targetPlatform` differs from the platform of the item's channel. */
  PlatformChannelMismatch: 'PLATFORM_CHANNEL_MISMATCH',
  /** A content master is archived only after all of its variants are archived. */
  MasterHasActiveVariants: 'MASTER_HAS_ACTIVE_VARIANTS',
  /** A content item never moves to another content master (AC014). */
  ContentMasterImmutable: 'CONTENT_MASTER_IMMUTABLE',

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

/** Error envelope defined in docs/API_SPEC.md §11. */
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
