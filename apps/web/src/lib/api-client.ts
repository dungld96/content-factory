'use client';

import { csrfToken } from './csrf-client';

export interface MutationResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  /** The API's error message, when the request failed. */
  readonly message: string | null;
}

/**
 * State-changing request from the browser through the same-origin rewrite, with the CSRF
 * token (ADR-0009). Never throws: network errors become `{ ok: false, status: 0 }`.
 */
export async function mutate<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<MutationResult<T>> {
  try {
    const token = await csrfToken();
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    const error = (json as { error?: { message?: unknown } } | null)?.error;
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? (json as T) : null,
      message: !res.ok && typeof error?.message === 'string' ? error.message : null,
    };
  } catch {
    return { ok: false, status: 0, data: null, message: 'The server could not be reached.' };
  }
}

export async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/v1${path}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
