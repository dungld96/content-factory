import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { originAllowed } from './security.guard.js';
import { sessionCookieConfig } from './session/session-cookies.js';

const req = (method: string, headers: Record<string, string>) =>
  ({ method, header: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

const ALLOWED = ['http://localhost:3000'];

describe('originAllowed', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('lets safe method %s through', (method) => {
    expect(originAllowed(req(method, {}), ALLOWED)).toBe(true);
  });

  it.each([
    [{ origin: 'http://localhost:3000' }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'same-origin' }, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ 'sec-fetch-site': 'same-site' }, false],
    [{}, false],
    // An explicit Origin decides, even with a same-origin fetch-site header.
    [{ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, false],
  ])('POST with %o -> %s', (headers, expected) => {
    expect(originAllowed(req('POST', headers), ALLOWED)).toBe(expected);
  });
});

describe('sessionCookieConfig', () => {
  it('uses __Host- names exactly when cookies are Secure', () => {
    expect(sessionCookieConfig({ SESSION_COOKIE_SECURE: true })).toEqual({
      sessionCookie: '__Host-acf_sid',
      csrfCookie: '__Host-acf_csrf',
      options: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' },
    });
    expect(sessionCookieConfig({ SESSION_COOKIE_SECURE: false }).sessionCookie).toBe('acf_sid');
  });
});
