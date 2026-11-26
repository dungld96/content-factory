import { z } from 'zod';

import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import { parseRetryAfter } from '../openrouter/errors.js';

/**
 * MixRoute error handling (verification record §5). The only documented body is the OpenAI shape
 * `{ "error": { "message", "type", "code" } }`; the status table is `docs/faq/error-code.md`.
 */
export const mixRouteErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().nullable().optional(),
    code: z.union([z.string(), z.number()]).nullable().optional(),
  }),
});
export type MixRouteErrorObject = z.infer<typeof mixRouteErrorBodySchema>['error'];

/** `error.code` / `error.type` values with a meaning of their own (OpenAI-compatible names). */
const BY_CODE: Readonly<Record<string, ProviderErrorCode>> = {
  invalid_api_key: ProviderErrorCode.AUTHENTICATION,
  // Live: validation errors come back as HTTP 500 with code invalid_request (2026-11-26).
  invalid_request: ProviderErrorCode.INVALID_REQUEST,
  insufficient_quota: ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED,
  insufficient_user_quota: ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED,
  model_not_found: ProviderErrorCode.MODEL_NOT_FOUND,
  context_length_exceeded: ProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  content_policy_violation: ProviderErrorCode.CONTENT_POLICY,
  content_filter: ProviderErrorCode.CONTENT_POLICY,
  rate_limit_exceeded: ProviderErrorCode.RATE_LIMITED,
};

/**
 * Documented statuses: 400 parameters, 401 invalid token, 403 token group disabled (usually the
 * token's quota is used up), 404 endpoint, 429 traffic limit, 500 internal, 503 model
 * unavailable, 504 gateway timeout.
 */
function byStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 401:
      return ProviderErrorCode.AUTHENTICATION;
    case 402:
    case 403:
      // "Token Group Disabled": a quota block, never retried (CLAUDE.md §7).
      return ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED;
    case 404:
      return ProviderErrorCode.MODEL_NOT_FOUND;
    case 408:
    case 504:
      return ProviderErrorCode.TIMEOUT;
    case 429:
      return ProviderErrorCode.RATE_LIMITED;
    case 502:
    case 503:
      return ProviderErrorCode.PROVIDER_UNAVAILABLE;
    default:
      return status >= 500 ? ProviderErrorCode.PROVIDER_ERROR : ProviderErrorCode.INVALID_REQUEST;
  }
}

export interface ClassifiedMixRouteError {
  readonly code: ProviderErrorCode;
  readonly providerErrorType: string | undefined;
  readonly providerCode: string | undefined;
  readonly message: string;
}

export function classifyMixRouteError(
  status: number,
  error: MixRouteErrorObject | undefined,
): ClassifiedMixRouteError {
  const providerCode =
    error?.code === null || error?.code === undefined ? undefined : String(error.code);
  const providerErrorType = error?.type ?? undefined;
  const code =
    (providerCode !== undefined ? BY_CODE[providerCode] : undefined) ??
    (providerErrorType !== undefined ? BY_CODE[providerErrorType] : undefined) ??
    byStatus(status);
  const message =
    code === ProviderErrorCode.CONTENT_POLICY
      ? 'content policy (MixRoute)' // the message may echo the prompt
      : (error?.message ?? `MixRoute HTTP ${String(status)}`);
  return { code, providerErrorType, providerCode, message };
}

/** A non-2xx response: the request was rejected before generation. */
export function mixRouteRejection(response: Response, raw: string): ProviderError {
  let error: MixRouteErrorObject | undefined;
  try {
    const parsed = mixRouteErrorBodySchema.safeParse(JSON.parse(raw));
    if (parsed.success) error = parsed.data.error;
  } catch {
    // Not JSON (e.g. an HTML error page): classify by status alone.
  }
  const classified = classifyMixRouteError(response.status, error);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  return new ProviderError(classified.code, classified.message, {
    outcome: ProviderErrorOutcome.REJECTED,
    httpStatus: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(classified.providerErrorType === undefined
      ? {}
      : { providerErrorType: classified.providerErrorType }),
    ...(classified.providerCode === undefined ? {} : { providerCode: classified.providerCode }),
  });
}

/**
 * MixRoute has no per-request zero-data-retention routing (verification record §6): a request
 * that needs it is refused before sending, never sent without it.
 */
export function refuseZeroDataRetention(): ProviderError {
  return new ProviderError(
    ProviderErrorCode.INVALID_REQUEST,
    'MixRoute cannot restrict a call to zero-data-retention endpoints',
    { outcome: ProviderErrorOutcome.NOT_SENT },
  );
}

/** Builds the abort signal for one call, or throws when the deadline has already passed. */
export function callSignal(
  signal: AbortSignal,
  deadlineAt: Date | undefined,
  timeoutMs: number,
): AbortSignal {
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt.getTime() - Date.now();
  if (signal.aborted || remaining <= 0) {
    throw new ProviderError(ProviderErrorCode.TIMEOUT, 'deadline passed before sending', {
      outcome: ProviderErrorOutcome.NOT_SENT,
    });
  }
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining))),
  ]);
}
