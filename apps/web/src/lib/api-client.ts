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
