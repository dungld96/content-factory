'use client';

/**
 * The CSRF token lives in memory only (never localStorage): set by the login response, and
 * re-fetched from `GET /api/v1/auth/csrf` after a reload.
 */
let token: string | null = null;

export function rememberCsrfToken(value: string): void {
  token = value;
}

export async function csrfToken(): Promise<string | null> {
  if (token) return token;
  const res = await fetch('/api/v1/auth/csrf', { cache: 'no-store' });
  if (!res.ok) return null;
  const body = (await res.json()) as { csrfToken?: unknown };
  token = typeof body.csrfToken === 'string' ? body.csrfToken : null;
  return token;
}

export function forgetCsrfToken(): void {
  token = null;
}
