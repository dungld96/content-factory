import type { KeyCheckResult } from '../key-check.js';
import type { OpenRouterConfig } from './config.js';

const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Checks an OpenRouter key with `GET /key` (P1 design O3): free, documented with `limit_remaining`,
 * `usage` and `is_free_tier` (verification record `docs/design/m2/openrouter-verification.md` §3).
 * Fields are read defensively: none is required; the HTTP status alone decides valid/rejected.
 */
export async function checkOpenRouterKey(
  config: OpenRouterConfig,
  signal?: AbortSignal,
): Promise<KeyCheckResult> {
  const timeout = AbortSignal.timeout(Math.min(config.timeoutMs, 15_000));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${config.baseUrl}/key`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      signal: combined,
      redirect: 'error',
    });
    raw = await response.text();
  } catch {
    return {
      result: 'unreachable',
      httpStatus: null,
      limitRemaining: null,
      usage: null,
      isFreeTier: null,
    };
  }
  const base = { httpStatus: response.status, limitRemaining: null, usage: null, isFreeTier: null };
  if (response.status === 401 || response.status === 403) return { result: 'rejected', ...base };
  if (!response.ok) return { result: 'unreachable', ...base };
  let data: Record<string, unknown> = {};
  try {
    const body = JSON.parse(raw) as { data?: unknown };
    if (typeof body.data === 'object' && body.data !== null)
      data = body.data as Record<string, unknown>;
  } catch {
    // A 200 without a readable body still proves the key was accepted.
  }
  return {
    result: 'valid',
    httpStatus: response.status,
    limitRemaining: number(data['limit_remaining']),
    usage: number(data['usage']),
    isFreeTier: typeof data['is_free_tier'] === 'boolean' ? data['is_free_tier'] : null,
  };
}
