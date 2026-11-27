// Session behaviour of the real API with the Prisma-backed store (ADR-0009 D2, design package
// §5.3, §5.9). Ported from docs/design/m1/evidence/session/test.mjs: the 25 baseline checks plus
// R1–R8 (revocation safety). Pauses use gates inside handlers instead of sleeps, so every
// interleaving is exact. The API connects as acf_app; assertions read the table as the migrator.
import { createHash } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';

import type { UserAdminService } from '../../src/users/user-admin.service.js';
import {
  gate,
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
const EDITOR = 'editor@example.test';

const sidOf = (jar: CookieJar) =>
  decodeURIComponent(jar.get('acf_sid') ?? '')
    .replace(/^s:/, '')
    .split('.')[0] ?? '';
const hash = (sid: string) => createHash('sha256').update(sid).digest();
const rowCount = async (sid: string) =>
  (await db.query('SELECT 1 FROM sessions WHERE id_hash = $1', [hash(sid)])).rowCount;
const totalRows = async () =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions')).rows[0]?.n;
const csrfOf = (res: CallResult) => (res.json as { csrfToken: string }).csrfToken;

async function login(jar: CookieJar, email = OWNER, password = PASSWORD): Promise<CallResult> {
  return call(jar, 'POST', '/auth/login', { body: { email, password } });
}

/** Logs in and returns the CSRF token for this session. */
async function signIn(jar: CookieJar, email = OWNER): Promise<string> {
  const res = await login(jar, email);
  expect(res.status).toBe(200);
  return csrfOf(res);
}

const me = (jar: CookieJar) => call(jar, 'GET', '/auth/me');
const logout = (jar: CookieJar, csrf: string) =>
  call(jar, 'POST', '/auth/logout', { headers: { 'x-csrf-token': csrf } });

/** store.set ran after the destroy/revoke-all and matched zero rows. */
const setAfterDestroy = () => {
  const i = api.events.findIndex((e) => e.type === 'destroyed' || e.type === 'revoked_all');
  return i >= 0 && api.events.slice(i + 1).some((e) => e.type === 'set' && !e.updated);
};

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  ({ users, prisma } = userAdmin());
  await users.create({ email: OWNER, displayName: 'Owner', password: PASSWORD });
  await users.create({ email: EDITOR, displayName: 'Editor', password: PASSWORD });
  api = await startAuthApp();
  call = client(api.baseUrl);
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

beforeEach(() => {
  api.events.length = 0;
});

describe('baseline', () => {
  it('sets an HttpOnly, SameSite=Lax, Path=/ cookie without Domain', async () => {
    const jar = new CookieJar();
    const res = await login(jar);
    expect(res.status).toBe(200);
    const cookie = res.setCookie.find((c) => c.startsWith('acf_sid=')) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/Secure/i); // SESSION_COOKIE_SECURE=false in tests
    expect((await me(jar)).status).toBe(200);
  });

  it('keys the row by sha256(sid), never stores the raw ID, and allow-lists the payload', async () => {
    const jar = new CookieJar();
    await signIn(jar);
    const sid = sidOf(jar);
    const { rows } = await db.query<{ data: Record<string, unknown>; user_id: string }>(
      'SELECT data, user_id FROM sessions WHERE id_hash = $1',
      [hash(sid)],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(sid);
    expect(Object.keys(rows[0]?.data ?? {}).sort()).toEqual([
      'authenticatedAt',
      'cookie',
      'userId',
    ]);
  });

  it('requires a valid CSRF token on unsafe requests', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const missing = await call(jar, 'POST', '/test-session/reauth');
    expect(missing.status).toBe(403);
    expect(missing.json).toMatchObject({ error: { code: 'CSRF_INVALID' } });
    const forged = await call(jar, 'POST', '/test-session/reauth', {
      headers: { 'x-csrf-token': `x${csrf.slice(1)}` },
    });
    expect(forged.status).toBe(403);
    const valid = await call(jar, 'POST', '/test-session/reauth', {
      headers: { 'x-csrf-token': csrf },
    });
    expect(valid.status).toBe(200);
  });

  it('defends against fixation: a new ID on login, the previous row deleted', async () => {
    const jar = new CookieJar();
    await signIn(jar);
    const before = sidOf(jar);
    await signIn(jar, EDITOR);
    const after = sidOf(jar);
    expect(after).not.toBe(before);
    expect(await rowCount(before)).toBe(0);
    const stale = new CookieJar();
    stale.set('acf_sid', `${encodeURIComponent('s:')}${before}.x`);
    expect((await me(stale)).status).toBe(401);
  });

  it('logout revokes immediately, even with a read-only request in flight', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const copy = jar.clone();
    const g = gate('baseline-read');
    const slowRead = call(copy, 'GET', '/test-session/read/baseline-read');
    await g.reached;
    const out = await logout(jar, csrf);
    expect(out.status).toBe(204);
    expect(out.setCookie.some((c) => /^acf_sid=;/.test(c))).toBe(true);
    g.open();
    await slowRead;
    expect((await me(copy)).status).toBe(401);
    expect(await rowCount(sidOf(copy))).toBe(0); // touch() could not resurrect it
  });

  it('serves 20 concurrent requests from one session with exactly one row', async () => {
    const jar = new CookieJar();
    await signIn(jar);
    const results = await Promise.all(Array.from({ length: 20 }, () => me(jar)));
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(await rowCount(sidOf(jar))).toBe(1);
  });

  it('treats idle-expired and absolute-expired sessions as absent', async () => {
    const idle = new CookieJar();
    await signIn(idle);
    await db.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`,
      [hash(sidOf(idle))],
    );
    expect((await me(idle)).status).toBe(401);

    const absolute = new CookieJar();
    await signIn(absolute);
    await db.query(
      `UPDATE sessions SET absolute_expires_at = now() - interval '1 second',
         expires_at = now() - interval '2 seconds' WHERE id_hash = $1`,
      [hash(sidOf(absolute))],
    );
    expect((await me(absolute)).status).toBe(401);
  });

  it('never extends the rolling expiry past the absolute expiry', async () => {
    const jar = new CookieJar();
    await signIn(jar);
    await db.query(
      `UPDATE sessions SET absolute_expires_at = now() + interval '1 hour',
         expires_at = now() + interval '1 hour', last_seen_at = now() - interval '1 hour'
       WHERE id_hash = $1`,
      [hash(sidOf(jar))],
    );
    expect((await me(jar)).status).toBe(200);
    const { rows } = await db.query<{ ok: boolean; touched: boolean }>(
      `SELECT expires_at <= absolute_expires_at AS ok, last_seen_at > now() - interval '1 minute' AS touched
       FROM sessions WHERE id_hash = $1`,
      [hash(sidOf(jar))],
    );
    expect(rows[0]).toEqual({ ok: true, touched: true });
  });

  it('revokes every session of a user on password change', async () => {
    await db.query(`DELETE FROM sessions`); // start from no editor sessions
    const a = new CookieJar();
    const b = new CookieJar();
    await signIn(a, EDITOR);
    await signIn(b, EDITOR);
    expect(await users.setPassword(EDITOR, PASSWORD)).toBe(2);
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(401);
  });

  it('rejects a garbage cookie without creating a row', async () => {
    const before = await totalRows();
    const jar = new CookieJar();
    jar.set('acf_sid', 'garbage');
    expect((await me(jar)).status).toBe(401);
    expect(await totalRows()).toBe(before);
  });
});

describe('revocation safety (CRITICAL-1)', () => {
  it('R1: A modifies a persisted field and pauses, B logs out, A completes: stays revoked', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const oldSid = sidOf(jar);
    const aJar = jar.clone();
    const g = gate('r1');
    api.events.length = 0;
    const reqA = call(aJar, 'POST', '/test-session/modify/r1', {
      headers: { 'x-csrf-token': csrf },
      noStore: true,
    });
    await g.reached;
    expect((await logout(jar, csrf)).status).toBe(204);
    expect(await rowCount(oldSid)).toBe(0);
    g.open();
    expect((await reqA).status).toBe(200); // it was authorized when it started
    expect(setAfterDestroy()).toBe(true);
    expect(await rowCount(oldSid)).toBe(0);
    expect((await me(aJar)).status).toBe(401);
  });

  it('R2: the same with a non-persisted field', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const oldSid = sidOf(jar);
    const aJar = jar.clone();
    const g = gate('r2');
    api.events.length = 0;
    const reqA = call(aJar, 'POST', '/test-session/modify-scratch/r2', {
      headers: { 'x-csrf-token': csrf },
      noStore: true,
    });
    await g.reached;
    await logout(jar, csrf);
    g.open();
    await reqA;
    expect(setAfterDestroy()).toBe(true);
    expect(await rowCount(oldSid)).toBe(0);
    expect((await me(aJar)).status).toBe(401);
  });

  it('R3: re-login while a modifying request on the old ID is in flight', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const oldSid = sidOf(jar);
    const aJar = jar.clone();
    const g = gate('r3');
    const reqA = call(aJar, 'POST', '/test-session/modify/r3', {
      headers: { 'x-csrf-token': csrf },
      noStore: true,
    });
    await g.reached;
    await signIn(jar);
    const newSid = sidOf(jar);
    g.open();
    await reqA;
    expect(await rowCount(oldSid)).toBe(0);
    expect((await me(aJar)).status).toBe(401);
    expect(newSid).not.toBe(oldSid);
    expect(await rowCount(newSid)).toBe(1);
    expect((await me(jar)).status).toBe(200);
  });

  it('R4: revoke-all while modifying requests on two sessions are in flight', async () => {
    await db.query(`DELETE FROM sessions`);
    const j1 = new CookieJar();
    const j2 = new CookieJar();
    const c1 = await signIn(j1, EDITOR);
    const c2 = await signIn(j2, EDITOR);
    const [s1, s2] = [sidOf(j1), sidOf(j2)];
    const g1 = gate('r4a');
    const g2 = gate('r4b');
    const r1 = call(j1.clone(), 'POST', '/test-session/modify/r4a', {
      headers: { 'x-csrf-token': c1 },
      noStore: true,
    });
    const r2 = call(j2.clone(), 'POST', '/test-session/modify-scratch/r4b', {
      headers: { 'x-csrf-token': c2 },
      noStore: true,
    });
    await Promise.all([g1.reached, g2.reached]);
    expect(await users.setPassword(EDITOR, PASSWORD)).toBe(2);
    g1.open();
    g2.open();
    await Promise.all([r1, r2]);
    expect(await rowCount(s1)).toBe(0);
    expect(await rowCount(s2)).toBe(0);
    expect((await me(j1)).status).toBe(401);
    expect((await me(j2)).status).toBe(401);
  });

  it('R5: 10 concurrent modifying requests with logout in the middle', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const oldSid = sidOf(jar);
    const opened = Array.from({ length: 10 }, (_, i) => gate(`r5-${i}`));
    const requests = opened.map((_, i) =>
      call(jar.clone(), 'POST', `/test-session/${i % 2 ? 'modify' : 'modify-scratch'}/r5-${i}`, {
        headers: { 'x-csrf-token': csrf },
        noStore: true,
      }),
    );
    await Promise.all(opened.slice(0, 5).map((g) => g.reached));
    opened.slice(0, 5).forEach((g) => {
      g.open();
    });
    await Promise.all(opened.map((g) => g.reached));
    await logout(jar.clone(), csrf);
    opened.forEach((g) => {
      g.open();
    });
    await Promise.all(requests);
    expect(await rowCount(oldSid)).toBe(0);
    expect((await me(jar)).status).toBe(401);
  });

  it('R6: a legitimate modification without logout still persists via UPDATE', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    api.events.length = 0;
    const res = await call(jar, 'POST', '/test-session/reauth', {
      headers: { 'x-csrf-token': csrf },
    });
    const { rows } = await db.query<{ at: string }>(
      `SELECT data->>'authenticatedAt' AS at FROM sessions WHERE id_hash = $1`,
      [hash(sidOf(jar))],
    );
    expect(rows[0]?.at).toBe((res.json as { authenticatedAt: string }).authenticatedAt);
    expect(api.events.some((e) => e.type === 'set' && e.updated)).toBe(true);
  });

  it('R7: an anonymous session write creates no row; failed login sets no cookie', async () => {
    const before = await totalRows();
    const anon = await call(new CookieJar(), 'POST', '/test-session/anon-write');
    expect(anon.status).toBe(200);
    expect(await totalRows()).toBe(before);
    // express-session still issues an (inert) cookie when app code writes to an anonymous
    // session. Design rule: public handlers never do (asserted in auth.integration.test.ts).
    const inert = anon.setCookie.find((c) => c.startsWith('acf_sid='))?.split(';')[0];
    expect(inert).toBeDefined();
    const inertJar = new CookieJar();
    inertJar.set('acf_sid', inert?.slice('acf_sid='.length) ?? '');
    expect((await me(inertJar)).status).toBe(401);

    const bad = await login(new CookieJar(), 'nobody@example.test', 'whatever-password');
    expect(bad.status).toBe(401);
    expect(bad.setCookie.some((c) => c.startsWith('acf_sid='))).toBe(false);
    expect(await totalRows()).toBe(before);
  });

  it('R8: login after logout yields a fresh, different session ID', async () => {
    const jar = new CookieJar();
    const csrf = await signIn(jar);
    const s1 = sidOf(jar);
    await logout(jar, csrf);
    await signIn(jar);
    const s2 = sidOf(jar);
    expect(s2).not.toBe(s1);
    expect(await rowCount(s1)).toBe(0);
    expect(await rowCount(s2)).toBe(1);
  });
});
