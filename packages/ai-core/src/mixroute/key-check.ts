import type { KeyCheckResult } from '../key-check.js';
import { mixRouteEndpoint, type MixRouteConfig } from './config.js';

/**
 * Checks a MixRoute key with `GET /models` (P5 decision G7; verification record §4): free and
 * authenticated (`401` = "API Key invalid or expired"). MixRoute reports no limit or usage here.
 */
export async function checkMixRouteKey(
  config: MixRouteConfig,
  signal?: AbortSignal,
): Promise<KeyCheckResult> {
  const timeout = AbortSignal.timeout(Math.min(config.timeoutMs, 15_000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const empty = { limitRemaining: null, usage: null, isFreeTier: null };
  let response: Response;
  try {
    response = await fetch(mixRouteEndpoint(config, '/models'), {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      signal: combined,
      redirect: 'error',
    });
    await response.arrayBuffer(); // drain; the model list is not needed
  } catch {
    return { result: 'unreachable', httpStatus: null, ...empty };
  }
  if (response.status === 401 || response.status === 403) {
    return { result: 'rejected', httpStatus: response.status, ...empty };
  }
  return {
    result: response.ok ? 'valid' : 'unreachable',
    httpStatus: response.status,
    ...empty,
  };
}
