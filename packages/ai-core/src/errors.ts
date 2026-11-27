import { redactSecrets } from '@acf/config';

/**
 * Normalized provider errors (M2 design package §4.3).
 *
 * Adapters never retry (decision P4). They classify every failure into one code whose policy says
 * whether a retry, or a switch to another compatible model or provider, is allowed
 * (AI_PROVIDER_STRATEGY §6, CLAUDE.md §7). The job layer (M5/M7) acts on the flags.
 */
import type { UsdAmount } from './money.js';
import type { LlmUsage } from './usage.js';

export const ProviderErrorCode = {
  AUTHENTICATION: 'AUTHENTICATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONTENT_POLICY: 'CONTENT_POLICY',
  PROVIDER_BUDGET_EXCEEDED: 'PROVIDER_BUDGET_EXCEEDED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONTEXT_LENGTH_EXCEEDED: 'CONTEXT_LENGTH_EXCEEDED',
  UNSUPPORTED_PARAMETER: 'UNSUPPORTED_PARAMETER',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
} as const;
export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

export interface ProviderErrorPolicy {
  /** The same request may be sent again later (bounded, with backoff: M7). */
  readonly retryable: boolean;
  /** Another compatible model/provider may be tried (AI_PROVIDER_STRATEGY §6). */
  readonly fallbackAllowed: boolean;
}

const deny: ProviderErrorPolicy = { retryable: false, fallbackAllowed: false };
const transient: ProviderErrorPolicy = { retryable: true, fallbackAllowed: true };

/**
 * Never retried and never failed over: invalid requests, policy blocks, authentication failures
 * and budget blocks (CLAUDE.md §7; AI_PROVIDER_STRATEGY §6).
 */
export const PROVIDER_ERROR_POLICY: Readonly<Record<ProviderErrorCode, ProviderErrorPolicy>> = {
  AUTHENTICATION: deny,
  PERMISSION_DENIED: deny,
  CONTENT_POLICY: deny,
  PROVIDER_BUDGET_EXCEEDED: deny,
  INVALID_REQUEST: deny,
  CONTEXT_LENGTH_EXCEEDED: deny,
  UNSUPPORTED_PARAMETER: deny,
  MODEL_NOT_FOUND: deny,
  RATE_LIMITED: transient,
  PROVIDER_UNAVAILABLE: transient,
  TIMEOUT: transient,
  NETWORK: transient,
  EMPTY_OUTPUT: transient,
  // A response that does not match the documented schema may repeat with any model of the same
  // provider; retry is allowed, switching on that basis is not.
  MALFORMED_RESPONSE: { retryable: true, fallbackAllowed: false },
  PROVIDER_ERROR: transient,
};

/** How far the request got. `unknown`: it may have been processed and charged (e.g. timeout). */
export const ProviderErrorOutcome = {
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  FAILED_AFTER_ACCEPTANCE: 'failed_after_acceptance',
  UNKNOWN: 'unknown',
} as const;
export type ProviderErrorOutcome = (typeof ProviderErrorOutcome)[keyof typeof ProviderErrorOutcome];

export interface ProviderErrorDetails {
  readonly outcome: ProviderErrorOutcome;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  /** Provider's typed error, e.g. OpenRouter `error.metadata.error_type`. */
  readonly providerErrorType?: string;
  /** Upstream provider code, when reported. */
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  /**
   * Usage the provider reported for a call that failed after acceptance: it may still be charged
   * (design package §7.3), so it is recorded like a successful call's usage.
   */
  readonly usage?: LlmUsage;
  readonly reportedCost?: UsdAmount | null;
  readonly cause?: unknown;
}

const MAX_MESSAGE_LENGTH = 500;

/** Bearer credentials and API-key-shaped tokens (e.g. OpenRouter `sk-or-v1-…`). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
];

/**
 * Makes a provider message safe to persist and log: credentials masked, single line, no control
 * characters, bounded. Callers must never pass prompt or completion text (e.g. moderation
 * `flagged_input`).
 */
export function sanitizeProviderMessage(message: string): string {
  // Shared credential shapes (URL credentials, signed-URL parameters, key=value secrets: M7 §10).
  let clean = redactSecrets(message);
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, (match, scheme?: string) =>
      typeof scheme === 'string' ? `${scheme} [redacted]` : '[redacted]',
    );
  }
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  clean = clean.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : clean;
}

export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;
  readonly outcome: ProviderErrorOutcome;
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;
  readonly providerErrorType: string | undefined;
  readonly providerCode: string | undefined;
  readonly providerRequestId: string | undefined;
  readonly usage: LlmUsage | undefined;
  readonly reportedCost: UsdAmount | null;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    details: ProviderErrorDetails,
  ) {
    super(
      sanitizeProviderMessage(message),
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    const policy = PROVIDER_ERROR_POLICY[code];
    this.retryable = policy.retryable;
    this.fallbackAllowed = policy.fallbackAllowed;
    this.outcome = details.outcome;
    this.retryAfterMs = details.retryAfterMs;
    this.httpStatus = details.httpStatus;
    this.providerErrorType = details.providerErrorType;
    this.providerCode = details.providerCode;
    this.providerRequestId = details.providerRequestId;
    this.usage = details.usage;
    this.reportedCost = details.reportedCost ?? null;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
