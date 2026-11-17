import 'server-only';

import { headers } from 'next/headers';

import { serverEnv } from './server-env';

export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'error'; readonly status: number | null };

/**
 * Server-to-server GET to the API on behalf of the signed-in browser: forwards only the
 * incoming `Cookie` header. Never used for state-changing requests (those go from the browser
 * through the same-origin rewrite, with Origin and CSRF checks).
 */
export async function apiGet<T>(path: string, timeoutMs = 5_000): Promise<ApiResult<T>> {
  const cookie = (await headers()).get('cookie');
  const url = new URL(`/api/v1${path}`, serverEnv().API_INTERNAL_URL);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { kind: 'unauthenticated' };
    if (!res.ok) return { kind: 'error', status: res.status };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error', status: null };
  }
}
