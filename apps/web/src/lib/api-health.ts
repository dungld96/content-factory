import 'server-only';

import { readinessResponseSchema, type ReadinessResponse } from '@acf/contracts';

import { serverEnv } from './server-env';

export type ApiHealthResult =
  | { readonly kind: 'ok' | 'degraded'; readonly data: ReadinessResponse }
  | { readonly kind: 'unreachable'; readonly reason: string };

/** Server-to-server readiness check. The browser never talks to dependencies directly. */
export async function fetchApiHealth(timeoutMs = 3_000): Promise<ApiHealthResult> {
  const url = new URL('/api/v1/health/ready', serverEnv().API_INTERNAL_URL);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const parsed = readinessResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { kind: 'unreachable', reason: `Unexpected response (HTTP ${res.status})` };
    }
    return { kind: parsed.data.status === 'ok' ? 'ok' : 'degraded', data: parsed.data };
  } catch (error: unknown) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return { kind: 'unreachable', reason: timedOut ? 'Request timed out' : 'API is not reachable' };
  }
}
