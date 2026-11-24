// Login, Origin/CSRF, guard and cookie behaviour of the real API (ADR-0009; design package §5.5,
// §5.6, §5.7, §8.1). Runs against the disposable acf_test_api database as acf_app.
import { createHash } from 'node:crypto';

import argon2 from 'argon2';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';

import { OpenApiService } from '../../src/openapi/openapi.service.js';
import type { UserAdminService } from '../../src/users/user-admin.service.js';
import {
  inspector,
  PASSWORD,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import { client, CookieJar, type CallResult } from '../support/http-client.js';

let api: AuthTestApp;
let db: pg.Client;
let users: UserAdminService;
let prisma: PrismaClient;
let call: ReturnType<typeof client>;

const OWNER = 'owner@example.test';
const DISABLED = 'disabled@example.test';
const PROJECT = '10000000-0000-7000-8000-000000000001';

const login = (jar: CookieJar | null, email: string, password = PASSWORD, headers = {}) =>
  call(jar, 'POST', '/auth/login', { body: { email, password }, headers });
const csrfOf = (res: CallResult) => (res.json as { csrfToken: string }).csrfToken;
const errorCode = (res: CallResult) => (res.json as { error: { code: string } }).error.code;
const sessionCookie = (res: CallResult) => res.setCookie.find((c) => /^(__Host-)?acf_sid=/.test(c));

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  ({ users, prisma } = userAdmin());
  const owner = await users.create({ email: OWNER, displayName: 'Owner', password: PASSWORD });
  await users.create({ email: DISABLED, displayName: 'Disabled', password: PASSWORD });
  await users.disable(DISABLED);
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${PROJECT}', 'Ngân Khánh', 'ngan-khanh', 'vi', 'Asia/Ho_Chi_Minh', '${owner.id}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES ('${PROJECT}', '${owner.id}', 'owner', now());
    COMMIT`);
  api = await startAuthApp();
  call = client(api.baseUrl);
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('login', () => {
  it('returns the profile and a CSRF token; normalizes the email; records lastLoginAt', async () => {
    const jar = new CookieJar();
    const res = await login(jar, '  Owner@Example.TEST ');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      user: { email: OWNER, displayName: 'Owner' },
      csrfToken: expect.any(String) as string,
    });
    expect(res.setCookie.some((c) => c.startsWith('acf_csrf='))).toBe(true);
    const { rows } = await db.query<{ recent: boolean }>(
      `SELECT last_login_at > now() - interval '1 minute' AS recent FROM users WHERE email = $1`,
      [OWNER],
    );
    expect(rows[0]?.recent).toBe(true);
  });

  it.each([
    ['an unknown email', 'nobody@example.test', PASSWORD],
    ['a wrong password', OWNER, 'wrong password, long enough'],
    ['a disabled account', DISABLED, PASSWORD],
  ])('rejects %s with the same generic 401 and no session cookie', async (_c, email, password) => {
    const res = await login(new CookieJar(), email, password);
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({
      error: { code: 'INVALID_CREDENTIALS', message: 'The email or password is incorrect.' },
    });
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('validates the body strictly', async () => {
    const res = await call(new CookieJar(), 'POST', '/auth/login', {
      body: { email: OWNER, password: PASSWORD, remember: true },
    });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('upgrades a hash with outdated Argon2 parameters on login', async () => {
    const email = 'legacy@example.test';
    const weak = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      timeCost: 2,
      memoryCost: 19_456,
    });
    await db.query(
      `INSERT INTO users (id, email, display_name, password_hash, updated_at)
       VALUES (gen_random_uuid(), $1, 'Legacy', $2, now())`,
      [email, weak],
    );
    expect((await login(new CookieJar(), email)).status).toBe(200);
    const { rows } = await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [email],
    );
    expect(rows[0]?.password_hash).not.toBe(weak);
    expect(rows[0]?.password_hash).toContain('m=65536,t=3,p=4');
    expect(await argon2.verify(rows[0]?.password_hash ?? '', PASSWORD)).toBe(true);
  });
});

describe('Origin check (design §5.7)', () => {
  it('rejects state-changing requests without Origin or Sec-Fetch-Site, including login', async () => {
    const res = await login(null, OWNER, PASSWORD, { origin: '' });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ORIGIN_REJECTED');
  });

  it('rejects a foreign origin', async () => {
    const res = await login(null, OWNER, PASSWORD, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('ORIGIN_REJECTED');
  });

  it('accepts Sec-Fetch-Site: same-origin when Origin is absent', async () => {
    const res = await login(new CookieJar(), OWNER, PASSWORD, {
      origin: '',
      'sec-fetch-site': 'same-origin',
    });
    expect(res.status).toBe(200);
  });
});

describe('session guard', () => {
  it.each([
    ['GET', '/auth/me'],
    ['GET', '/auth/csrf'],
    ['POST', '/auth/logout'],
  ])('%s %s without a session is 401 (before any CSRF check)', async (method, path) => {
    const res = await call(new CookieJar(), method, path);
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('UNAUTHORIZED');
  });

  it('returns the profile with memberships', async () => {
    const jar = new CookieJar();
    await login(jar, OWNER);
    const res = await call(jar, 'GET', '/auth/me');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      user: { id: expect.any(String) as string, email: OWNER, displayName: 'Owner' },
      memberships: [
        { projectId: PROJECT, projectSlug: 'ngan-khanh', projectName: 'Ngân Khánh', role: 'owner' },
      ],
      // P1 O1: not in OPERATOR_EMAILS.
      isOperator: false,
      // R-D6: no choice yet, the browser decides.
      locale: null,
    });
  });

  it('saves the interface language on the user (R-D6) and validates it', async () => {
    const jar = new CookieJar();
    await login(jar, OWNER);
    const token = csrfOf(await call(jar, 'GET', '/auth/csrf'));
    const headers = { 'x-csrf-token': token };
    const set = await call(jar, 'PATCH', '/auth/me/preferences', {
      headers,
      body: { locale: 'vi' },
    });
    expect(set.status).toBe(200);
    expect((set.json as { locale: string }).locale).toBe('vi');
    expect(((await call(jar, 'GET', '/auth/me')).json as { locale: string }).locale).toBe('vi');
    const bad = await call(jar, 'PATCH', '/auth/me/preferences', {
      headers,
      body: { locale: 'fr' },
    });
    expect(bad.status).toBe(400);
    const reset = await call(jar, 'PATCH', '/auth/me/preferences', {
      headers,
      body: { locale: null },
    });
    expect((reset.json as { locale: string | null }).locale).toBeNull();
  });

  it('destroys the session when its user is disabled behind its back', async () => {
    const email = 'later-disabled@example.test';
    await users.create({ email, displayName: 'Later', password: PASSWORD });
    const jar = new CookieJar();
    await login(jar, email);
    const sid =
      decodeURIComponent(jar.get('acf_sid') ?? '')
        .replace(/^s:/, '')
        .split('.')[0] ?? '';
    // Direct SQL, so the CLI's revoke-all does not run: the guard must catch it.
    await db.query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [email]);
    expect((await call(jar, 'GET', '/auth/me')).status).toBe(401);
    const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE id_hash = $1', [
      createHash('sha256').update(sid).digest(),
    ]);
    expect(rowCount).toBe(0);
  });
});

describe('CSRF tokens', () => {
  it('GET /auth/csrf issues a working token', async () => {
    const jar = new CookieJar();
    await login(jar, OWNER);
    const res = await call(jar, 'GET', '/auth/csrf');
    expect(res.status).toBe(200);
    const out = await call(jar, 'POST', '/auth/logout', {
      headers: { 'x-csrf-token': csrfOf(res) },
    });
    expect(out.status).toBe(204);
  });

  it('a token is bound to its session and dies with it', async () => {
    const a = new CookieJar();
    const b = new CookieJar();
    const tokenA = csrfOf(await login(a, OWNER));
    await login(b, OWNER);
    const crossed = await call(b, 'POST', '/test-session/reauth', {
      headers: { 'x-csrf-token': tokenA },
    });
    expect(crossed.status).toBe(403);

    await login(a, OWNER); // re-login: new session ID
    const stale = await call(a, 'POST', '/test-session/reauth', {
      headers: { 'x-csrf-token': tokenA },
    });
    expect(stale.status).toBe(403);
    expect(errorCode(stale)).toBe('CSRF_INVALID');
  });
});

describe('public routes', () => {
  it('no public GET route sets a session cookie (design rule, §5.3.1)', async () => {
    const publicGets = api.app
      .get(OpenApiService)
      .routes()
      .filter((r) => r.method === 'get' && r.publicRule !== undefined && !r.path.includes(':'));
    expect(publicGets.map((r) => r.path)).toEqual(
      expect.arrayContaining(['/health', '/health/ready', '/openapi.json']),
    );
    for (const route of publicGets) {
      const res = await call(new CookieJar(), 'GET', route.path);
      expect(sessionCookie(res), route.path).toBeUndefined();
    }
  });
});

describe('secure cookies behind the TLS proxy (design §5.6)', () => {
  let secure: AuthTestApp;
  let secureCall: ReturnType<typeof client>;

  beforeAll(async () => {
    secure = await startAuthApp({ SESSION_COOKIE_SECURE: 'true' });
    secureCall = client(secure.baseUrl);
  });
  afterAll(async () => {
    await secure.close();
  });

  it('fails closed when the request did not arrive over HTTPS (no row, no cookie)', async () => {
    const before = (await db.query('SELECT 1 FROM sessions')).rowCount;
    const res = await secureCall(new CookieJar(), 'POST', '/auth/login', {
      body: { email: OWNER, password: PASSWORD },
    });
    expect(res.status).toBe(500);
    expect(errorCode(res)).toBe('SESSION_COOKIE_NOT_SET');
    expect(sessionCookie(res)).toBeUndefined();
    expect((await db.query('SELECT 1 FROM sessions')).rowCount).toBe(before);
  });

  it('sets __Host- cookies when the trusted proxy reports HTTPS', async () => {
    const jar = new CookieJar();
    const res = await secureCall(jar, 'POST', '/auth/login', {
      body: { email: OWNER, password: PASSWORD },
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res) ?? '';
    expect(cookie).toMatch(/^__Host-acf_sid=/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(res.setCookie.some((c) => /^__Host-acf_csrf=.*; Secure/.test(c))).toBe(true);
  });
});

describe('login throttling', () => {
  let limited: AuthTestApp;
  beforeAll(async () => {
    limited = await startAuthApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('returns 429 RATE_LIMITED after the per-minute limit', async () => {
    const limitedCall = client(limited.baseUrl);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await limitedCall(new CookieJar(), 'POST', '/auth/login', {
        body: { email: OWNER, password: 'wrong password, long enough' },
      });
      statuses.push(res.status);
      if (res.status === 429) expect(errorCode(res)).toBe('RATE_LIMITED');
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});
