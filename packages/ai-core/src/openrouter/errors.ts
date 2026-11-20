import { ProviderErrorCode } from '../errors.js';
import type { OpenRouterErrorObject } from './schema.js';

/**
 * OpenRouter `error.metadata.error_type` → normalized code (design package §4.3; verification
 * record §2). Unknown types fall back to the HTTP status.
 */
const BY_ERROR_TYPE: Readonly<Record<string, ProviderErrorCode>> = {
  authentication: ProviderErrorCode.AUTHENTICATION,
  permission_denied: ProviderErrorCode.PERMISSION_DENIED,
  payment_required: ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED,
  content_policy_violation: ProviderErrorCode.CONTENT_POLICY,
  refusal: ProviderErrorCode.CONTENT_POLICY,
  context_length_exceeded: ProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  string_too_long: ProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  token_limit_exceeded: ProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
  max_tokens_exceeded: ProviderErrorCode.INVALID_REQUEST,
  invalid_request: ProviderErrorCode.INVALID_REQUEST,
  invalid_prompt: ProviderErrorCode.INVALID_REQUEST,
  unprocessable: ProviderErrorCode.INVALID_REQUEST,
  payload_too_large: ProviderErrorCode.INVALID_REQUEST,
  precondition_failed: ProviderErrorCode.INVALID_REQUEST,
  invalid_image: ProviderErrorCode.INVALID_REQUEST,
  image_too_large: ProviderErrorCode.INVALID_REQUEST,
  image_too_small: ProviderErrorCode.INVALID_REQUEST,
  unsupported_image_format: ProviderErrorCode.INVALID_REQUEST,
  image_not_found: ProviderErrorCode.INVALID_REQUEST,
  image_download_failed: ProviderErrorCode.INVALID_REQUEST,
  not_found: ProviderErrorCode.MODEL_NOT_FOUND,
  rate_limit_exceeded: ProviderErrorCode.RATE_LIMITED,
  provider_overloaded: ProviderErrorCode.PROVIDER_UNAVAILABLE,
  provider_unavailable: ProviderErrorCode.PROVIDER_UNAVAILABLE,
  timeout: ProviderErrorCode.TIMEOUT,
  server: ProviderErrorCode.PROVIDER_ERROR,
  unmapped: ProviderErrorCode.PROVIDER_ERROR,
};

/** Budget blocks reported as 403 (verification record §2). */
const BUDGET_LIMIT_SOURCES = new Set([
  'openrouter_guardrail_budget',
  'openrouter_workspace_budget',
  'openrouter_key_limit',
]);

function byStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 401:
      return ProviderErrorCode.AUTHENTICATION;
    case 402:
      return ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED;
    case 403:
      return ProviderErrorCode.PERMISSION_DENIED;
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
      if (status >= 500) return ProviderErrorCode.PROVIDER_ERROR;
      return ProviderErrorCode.INVALID_REQUEST;
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface ClassifiedError {
  readonly code: ProviderErrorCode;
  readonly providerErrorType: string | undefined;
  readonly providerCode: string | undefined;
  /** Safe message: never moderation input, which can echo the prompt. */
  readonly message: string;
}

/** Classifies an OpenRouter error object under the HTTP status it arrived with (or carried). */
export function classifyOpenRouterError(
  status: number,
  error: OpenRouterErrorObject | undefined,
): ClassifiedError {
  const metadata = error?.metadata ?? {};
  const errorType = str(metadata['error_type']);
  const limitSource = str(metadata['limit_source']);
  const reason = str(metadata['reason']);
  const providerCode = str(metadata['provider_code']);

  let code: ProviderErrorCode;
  if (
    status === 402 &&
    (limitSource === 'openrouter_in_flight_budget' || reason === 'in_flight_budget_exhausted')
  ) {
    // Transient: running requests fill the in-flight budget; Retry-After says when to retry.
    code = ProviderErrorCode.RATE_LIMITED;
  } else if (limitSource !== undefined && BUDGET_LIMIT_SOURCES.has(limitSource)) {
    code = ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED;
  } else if (errorType !== undefined && errorType in BY_ERROR_TYPE) {
    code = BY_ERROR_TYPE[errorType] ?? byStatus(status);
  } else if (Array.isArray(metadata['reasons']) || 'flagged_input' in metadata) {
    code = ProviderErrorCode.CONTENT_POLICY; // moderation metadata
  } else {
    code = byStatus(status);
  }

  const message =
    code === ProviderErrorCode.CONTENT_POLICY
      ? `content policy (${errorType ?? 'moderation'})`
      : withUpstreamDetail(error?.message ?? `OpenRouter HTTP ${String(status)}`, metadata);
  return { code, providerErrorType: errorType, providerCode, message };
}

/**
 * OpenRouter wraps upstream failures as "Provider returned error" and puts the upstream body in
 * `metadata.raw` (M8 pilot: Gemini's "schema produces a constraint that has too many states" was
 * invisible). Appends the upstream message (its `error.message` when the body is JSON) and the
 * provider name. The caller's ProviderError sanitizes and bounds the result; content-policy errors
 * never come here (their metadata may echo the input).
 */
function withUpstreamDetail(message: string, metadata: Record<string, unknown>): string {
  const raw = str(metadata['raw']);
  if (raw === undefined) return message;
  let upstream = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === 'string') upstream = parsed.error.message;
  } catch {
    // not JSON: keep the raw text
  }
  const provider = str(metadata['provider_name']);
  return `${message} (${provider ? `${provider}: ` : ''}${upstream.slice(0, 300)})`;
}

/** `Retry-After` as delta-seconds or an HTTP date, in milliseconds; undefined when absent/invalid. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Only an HTTP-date (it has a weekday/month name); Date.parse also accepts e.g. '-1' as a year.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** The HTTP status an error object carries (`error.code`), if numeric. */
export function errorStatus(error: OpenRouterErrorObject | null | undefined): number | undefined {
  const code = error?.code;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}
