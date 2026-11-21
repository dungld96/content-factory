import type { CookieOptions } from 'express';

import type { ApiEnv } from '@acf/config';

/**
 * Cookie names and attributes (ADR-0009). `__Host-` requires `Secure`, `Path=/` and no
 * `Domain`, so the prefix is used exactly when cookies are secure.
 */
export interface SessionCookieConfig {
  readonly sessionCookie: string;
  readonly csrfCookie: string;
  readonly options: CookieOptions;
}

export function sessionCookieConfig(
  env: Pick<ApiEnv, 'SESSION_COOKIE_SECURE'>,
): SessionCookieConfig {
  const secure = env.SESSION_COOKIE_SECURE;
  return {
    sessionCookie: secure ? '__Host-acf_sid' : 'acf_sid',
    csrfCookie: secure ? '__Host-acf_csrf' : 'acf_csrf',
    options: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
  };
}
