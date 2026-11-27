import { ProviderError, ProviderErrorOutcome } from '../errors.js';
import { classifyOpenRouterError, parseRetryAfter } from './errors.js';
import { openRouterErrorBodySchema, type OpenRouterErrorObject } from './schema.js';

/** A non-2xx response: classified like every OpenRouter error (M2 table). */
export function rejection(response: Response, raw: string): ProviderError {
  let error: OpenRouterErrorObject | undefined;
  try {
    const parsed = openRouterErrorBodySchema.safeParse(JSON.parse(raw));
    if (parsed.success) error = parsed.data.error;
  } catch {
    // Not JSON: classify by status alone.
  }
  const classified = classifyOpenRouterError(response.status, error);
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
