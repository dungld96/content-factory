'use client';

import { csrfToken } from './csrf-client';

export interface MutationResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  /** The API's error message, when the request failed. */
  readonly message: string | null;
  /** The API's error code (`BUDGET_EXCEEDED`, …), when the request failed. */
  readonly code?: string | null;
  /** Per-field problems of a 400/422 (e.g. which storyboard rule is broken), when the API sent them. */
  readonly details?: readonly { readonly path: string; readonly message: string }[];
  /** The API's `error.current` (the state the request conflicted with), when it sent one. */
  readonly current?: unknown;
}

/** The error to show for a failed request: the message plus each named problem (M8.5 Q6). */
export function errorText(r: MutationResult<unknown>): string {
  const base = r.message ?? `Request failed (HTTP ${String(r.status)})`;
  const details = (r.details ?? []).map((d) => d.message).filter((m) => m.length > 0);
  return details.length > 0 ? `${base} ${details.join('; ')}.` : base;
}

/** Asks before spending above a soft budget (M7 §3), with the browser's confirmation dialog. */
function confirmOverBudget(message: string): boolean {
  return typeof window !== 'undefined' && window.confirm(`${message}\n\nProceed anyway?`);
}

/**
 * State-changing request from the browser through the same-origin rewrite, with the CSRF
 * token (ADR-0009). Never throws: network errors become `{ ok: false, status: 0 }`.
 *
 * A request refused with `409 BUDGET_CONFIRMATION_REQUIRED` (a soft budget would be exceeded)
 * is shown to the user once and, if they confirm, sent again with `acceptOverBudget: true`
 * (recorded as an override). Hard limits (`402 BUDGET_EXCEEDED`) are never retried.
 */
export async function mutate<T>(
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<MutationResult<T>> {
  const first = await send<T>(method, path, body);
  const plain = typeof body === 'object' && body !== null && !Array.isArray(body);
  if (
    first.code === 'BUDGET_CONFIRMATION_REQUIRED' &&
    (body === undefined || plain) &&
    confirmOverBudget(first.message ?? 'This request exceeds a soft budget.')
  ) {
    return send<T>(method, path, {
      ...((body ?? {}) as Record<string, unknown>),
      acceptOverBudget: true,
    });
  }
  return first;
}

async function send<T>(
  method: 'POST' | 'PATCH' | 'PUT',
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
    const error = (
      json as {
        error?: { message?: unknown; code?: unknown; details?: unknown; current?: unknown };
      } | null
    )?.error;
    const details = detailsOf(error?.details);
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? (json as T) : null,
      message: !res.ok && typeof error?.message === 'string' ? error.message : null,
      code: !res.ok && typeof error?.code === 'string' ? error.code : null,
      ...(details.length > 0 ? { details } : {}),
      ...(!res.ok && error?.current !== undefined ? { current: error.current } : {}),
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

/** Raw-body image upload (M4a): the file itself is the request body, never JSON. */
export async function uploadImage<T>(
  projectId: string,
  file: File,
  options: {
    assetType: 'reference' | 'image' | 'audio';
    label?: string;
    contentItemId?: string;
    /** Audio only (M5 §7.3): voice-over narration or licensed music. */
    purpose?: 'voiceover' | 'music';
    licenseNote?: string;
  },
): Promise<MutationResult<T>> {
  try {
    const token = await csrfToken();
    const query = new URLSearchParams({ assetType: options.assetType, filename: file.name });
    if (options.label) query.set('label', options.label);
    if (options.contentItemId) query.set('contentItemId', options.contentItemId);
    if (options.purpose) query.set('purpose', options.purpose);
    if (options.licenseNote) query.set('licenseNote', options.licenseNote);
    const res = await fetch(`/api/v1/projects/${projectId}/assets/upload?${query.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: file,
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

/** `error.details` of an API error envelope: `{ path, message }` items only. */
function detailsOf(value: unknown): { path: string; message: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return [];
    const { path, message } = d as { path?: unknown; message?: unknown };
    return typeof message === 'string'
      ? [{ path: typeof path === 'string' ? path : '', message }]
      : [];
  });
}
