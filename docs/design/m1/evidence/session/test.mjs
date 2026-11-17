// Session behaviour suite for the Prisma-backed store, run THROUGH the Next.js rewrite proxy.
// DB assertions use a separate inspection connection; the API itself connects as acf_app (U3).
import { createHash } from 'node:crypto';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const API = process.env.API ?? 'http://127.0.0.1:4100';
const ORIGIN = 'http://localhost:3100';
const pool = new pg.Pool({ connectionString: process.env.INSPECT_DATABASE_URL });
const results = [];
const check = (group, name, ok, detail = '') => results.push({ group, ok: !!ok, name, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Jar {
  c = new Map();
  store(res) {
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) this.c.delete(k); else this.c.set(k, v);
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  clone() { const j = new Jar(); j.c = new Map(this.c); return j; }
}
async function call(jar, method, path, body, extra = {}) {
  const res = await fetch(BASE + path, { method, redirect: 'manual',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(jar ? { cookie: jar.header() } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined });
  if (!extra.noStore) jar?.store(res);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const sidOf = (jar) => decodeURIComponent(jar.c.get('acf_sid') ?? '').replace(/^s:/, '').split('.')[0];
const hash = (sid) => createHash('sha256').update(sid).digest();
const rowCount = async (sid) => (await pool.query('SELECT 1 FROM sessions WHERE id_hash = $1', [hash(sid)])).rowCount;
const totalRows = async () => (await pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n;
const events = async () => (await fetch(API + '/api/v1/debug/store-events')).json();
const resetEvents = () => fetch(API + '/api/v1/debug/store-events/reset', { method: 'POST' });
const login = async (jar, email = 'owner@example.test') => call(jar, 'POST', '/api/v1/auth/login', { email });

// ============================== baseline behaviour (ported 25 checks) ==============================
const a = new Jar();
const l1 = await login(a);
const sc = l1.setCookie.find((c) => c.startsWith('acf_sid=')) ?? '';
check('base', 'login 200 through Next rewrite', l1.status === 200, l1.status);
check('base', 'Set-Cookie forwarded by Next rewrite', sc.length > 0);
check('base', 'cookie HttpOnly + SameSite=Lax + Path=/, no Domain', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && !/Domain=/i.test(sc));
check('base', 'me 200 with session', (await call(a, 'GET', '/api/v1/auth/me')).status === 200);
const sid = sidOf(a);
const row = (await pool.query('SELECT data, user_id FROM sessions WHERE id_hash = $1', [hash(sid)])).rows[0];
check('base', 'row keyed by sha256(sid)', !!row);
check('base', 'raw sid not stored anywhere in row', row && !JSON.stringify(row).includes(sid));
check('base', 'payload keys are allow-listed', row && JSON.stringify(Object.keys(row.data).sort()) === '["authenticatedAt","cookie","userId"]', row && Object.keys(row.data));
check('base', 'mutate without CSRF token -> 403', (await call(a, 'POST', '/api/v1/mutate', {})).status === 403);
check('base', 'mutate with CSRF token -> 200', (await call(a, 'POST', '/api/v1/mutate', {}, { 'x-csrf-token': l1.json.csrfToken })).status === 200);
check('base', 'mutate with forged token -> 403', (await call(a, 'POST', '/api/v1/mutate', {}, { 'x-csrf-token': 'x' + l1.json.csrfToken.slice(1) })).status === 403);
const before = sidOf(a);
await login(a, 'editor@example.test');
const after = sidOf(a);
check('base', 'fixation: session ID changes on login', before && after && before !== after);
check('base', 'fixation: previous session row deleted', (await rowCount(before)) === 0);
const stale = new Jar(); stale.c.set('acf_sid', encodeURIComponent('s:') + before + '.x');
check('base', 'old/forged cookie value -> 401', (await call(stale, 'GET', '/api/v1/auth/me')).status === 401);
const b = new Jar(); await login(b);
const bCopy = b.clone();
const slowRead = call(bCopy, 'GET', '/api/v1/auth/slow');
await sleep(200);
const out = await call(b, 'POST', '/api/v1/auth/logout');
check('base', 'logout 204', out.status === 204);
check('base', 'logout clears cookie', out.setCookie.some((c) => /acf_sid=;/.test(c)));
await slowRead;
check('base', 'same cookie after logout -> 401', (await call(bCopy, 'GET', '/api/v1/auth/me')).status === 401);
check('base', 'read-only in-flight request did not resurrect (touch path)', (await rowCount(sidOf(bCopy))) === 0);
const c = new Jar(); await login(c);
const many = await Promise.all(Array.from({ length: 20 }, () => call(c, 'GET', '/api/v1/auth/me')));
check('base', '20 concurrent requests all 200', many.every((r) => r.status === 200), many.map((r) => r.status).join(','));
check('base', 'exactly one row for that session', (await rowCount(sidOf(c))) === 1);
await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [hash(sidOf(c))]);
check('base', 'idle-expired session -> 401', (await call(c, 'GET', '/api/v1/auth/me')).status === 401);
const d = new Jar(); await login(d);
await pool.query(`UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() - interval '2 second' WHERE id_hash = $1`, [hash(sidOf(d))]);
check('base', 'absolute-expired session -> 401', (await call(d, 'GET', '/api/v1/auth/me')).status === 401);
const e = new Jar(); await login(e);
await pool.query(`UPDATE sessions SET absolute_expires_at = now() + interval '1 hour', expires_at = now() + interval '1 hour', last_seen_at = now() - interval '1 hour' WHERE id_hash = $1`, [hash(sidOf(e))]);
await call(e, 'GET', '/api/v1/auth/me');
check('base', 'rolling touch never extends past absolute expiry', (await pool.query(`SELECT expires_at <= absolute_expires_at AS ok FROM sessions WHERE id_hash = $1`, [hash(sidOf(e))])).rows[0]?.ok === true);
const f1 = new Jar(), f2 = new Jar();
await login(f1, 'editor@example.test'); await login(f2, 'editor@example.test');
await fetch(API + '/api/v1/debug/revoke-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'editor@example.test' }) });
check('base', 'revoke-all: both sessions -> 401', (await call(f1, 'GET', '/api/v1/auth/me')).status === 401 && (await call(f2, 'GET', '/api/v1/auth/me')).status === 401);
const rowsBefore = await totalRows();
const g = new Jar(); g.c.set('acf_sid', 'garbage');
check('base', 'garbage cookie -> 401', (await call(g, 'GET', '/api/v1/auth/me')).status === 401);
check('base', 'unauthenticated request created no row', (await totalRows()) === rowsBefore);

// ============================== CRITICAL-1 regressions ==============================
const setAfterDestroy = (evts) => {
  const iDestroy = evts.findIndex((x) => x.type === 'destroyed' || x.type === 'revoked_all');
  return iDestroy >= 0 && evts.slice(iDestroy + 1).some((x) => x.type === 'set' && x.updated === false);
};

// R1 — exactly the reviewer's scenario: A modifies a persisted field and pauses; B logs out; A completes.
{
  const jar = new Jar(); await login(jar);
  const oldSid = sidOf(jar);
  const aJar = jar.clone();
  await resetEvents();
  const reqA = call(aJar, 'POST', '/api/v1/auth/slow-modify', {}, { noStore: true });
  await sleep(300);
  const logout = await call(jar, 'POST', '/api/v1/auth/logout');
  const rowsAfterLogout = await rowCount(oldSid);
  const resA = await reqA;
  await sleep(100);
  const evts = await events();
  check('R1', 'B logout 204 while A in flight', logout.status === 204);
  check('R1', 'row absent right after logout', rowsAfterLogout === 0);
  check('R1', 'A completed (it was authorized when it started)', resA.status === 200, resA.status);
  check('R1', 'store.set WAS invoked after destroy and matched 0 rows', setAfterDestroy(evts), JSON.stringify(evts));
  check('R1', 'old session row still absent after A completed', (await rowCount(oldSid)) === 0);
  check('R1', 'old cookie -> 401', (await call(aJar, 'GET', '/api/v1/auth/me')).status === 401);
}
// R2 — A modifies a NON-persisted field (still a modified session -> set)
{
  const jar = new Jar(); await login(jar); const oldSid = sidOf(jar); const aJar = jar.clone();
  await resetEvents();
  const reqA = call(aJar, 'POST', '/api/v1/auth/slow-modify-scratch', {}, { noStore: true });
  await sleep(300); await call(jar, 'POST', '/api/v1/auth/logout'); await reqA; await sleep(100);
  check('R2', 'set after destroy matched 0 rows', setAfterDestroy(await events()));
  check('R2', 'old row absent, old cookie -> 401', (await rowCount(oldSid)) === 0 && (await call(aJar, 'GET', '/api/v1/auth/me')).status === 401);
}
// R3 — re-login (regenerate) while a modifying request on the OLD sid is in flight
{
  const jar = new Jar(); await login(jar); const oldSid = sidOf(jar); const aJar = jar.clone();
  await resetEvents();
  const reqA = call(aJar, 'POST', '/api/v1/auth/slow-modify', {}, { noStore: true });
  await sleep(300); await login(jar); const newSid = sidOf(jar); await reqA; await sleep(100);
  check('R3', 'old sid absent after regenerate + late set', (await rowCount(oldSid)) === 0);
  check('R3', 'old cookie -> 401', (await call(aJar, 'GET', '/api/v1/auth/me')).status === 401);
  check('R3', 'new session created legitimately and works', newSid !== oldSid && (await rowCount(newSid)) === 1 && (await call(jar, 'GET', '/api/v1/auth/me')).status === 200);
}
// R4 — revoke-all (password change / disable) while modifying requests on two sessions are in flight
{
  const j1 = new Jar(), j2 = new Jar();
  await login(j1, 'editor@example.test'); await login(j2, 'editor@example.test');
  const s1 = sidOf(j1), s2 = sidOf(j2);
  const r1 = call(j1.clone(), 'POST', '/api/v1/auth/slow-modify', {}, { noStore: true });
  const r2 = call(j2.clone(), 'POST', '/api/v1/auth/slow-modify-scratch', {}, { noStore: true });
  await sleep(300);
  const rv = await (await fetch(API + '/api/v1/debug/revoke-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'editor@example.test' }) })).json();
  await Promise.all([r1, r2]); await sleep(100);
  check('R4', 'revoke-all deleted both sessions', rv.revoked === 2, JSON.stringify(rv));
  check('R4', 'neither session resurrected by late set', (await rowCount(s1)) === 0 && (await rowCount(s2)) === 0);
  check('R4', 'both old cookies -> 401', (await call(j1, 'GET', '/api/v1/auth/me')).status === 401 && (await call(j2, 'GET', '/api/v1/auth/me')).status === 401);
}
// R5 — 10 concurrent modifying requests, logout in the middle
{
  const jar = new Jar(); await login(jar); const oldSid = sidOf(jar);
  const reqs = Array.from({ length: 10 }, (_, i) => sleep(i * 40).then(() => call(jar.clone(), 'POST', i % 2 ? '/api/v1/auth/slow-modify' : '/api/v1/auth/slow-modify-scratch', {}, { noStore: true })));
  await sleep(250); await call(jar.clone(), 'POST', '/api/v1/auth/logout', undefined, { noStore: true });
  const statuses = (await Promise.all(reqs)).map((r) => r.status); await sleep(100);
  check('R5', 'no resurrection after 10 concurrent modifying requests', (await rowCount(oldSid)) === 0, statuses.join(','));
  check('R5', 'old cookie -> 401', (await call(jar, 'GET', '/api/v1/auth/me')).status === 401);
}
// R6 — legitimate modification without logout still persists (set is UPDATE, not a no-op)
{
  const jar = new Jar(); await login(jar); await resetEvents();
  const r = await call(jar, 'POST', '/api/v1/auth/reauth', {});
  const stored = (await pool.query(`SELECT data->>'authenticatedAt' AS at FROM sessions WHERE id_hash = $1`, [hash(sidOf(jar))])).rows[0]?.at;
  check('R6', 'modified session persisted via UPDATE', stored === r.json.authenticatedAt, `${stored} vs ${r.json.authenticatedAt}`);
  check('R6', 'set reported updated=true', (await events()).some((x) => x.type === 'set' && x.updated === true));
}
// R7 — anonymous request writing to req.session: no row, no session cookie, no 500
{
  const n0 = await totalRows(); await resetEvents();
  const r = await call(new Jar(), 'POST', '/api/v1/debug/anon-write', {});
  check('R7', 'anonymous session write returns 200 (no 500)', r.status === 200, r.status);
  check('R7', 'no session row created', (await totalRows()) === n0);
  // express-session itself issues a cookie when app code writes to an ANONYMOUS session; the store
  // cannot suppress it. It is inert (asserted below). M1 rule: public handlers never write to
  // req.session; enforced by a "public routes set no session cookie" test (as for failed login).
  check('R7', 'documented: anonymous write still gets a (meaningless) express-session cookie', r.setCookie.some((x) => x.startsWith('acf_sid=')));
  const bad = await call(new Jar(), 'POST', '/api/v1/auth/login', { email: 'nobody@example.test' });
  check('R7', 'failed login (public route): 401 and NO session cookie, NO row', bad.status === 401 && !bad.setCookie.some((x) => x.startsWith('acf_sid=')) && (await totalRows()) === n0);
  check('R7', 'any issued anonymous cookie is unauthenticated', (await call(new Jar(), 'GET', '/api/v1/auth/me', undefined, { cookie: r.setCookie.map((x) => x.split(';')[0]).join('; ') })).status === 401);
}
// R8 — DB-level check: the runtime role can only reach rows via the store's statements; a direct
//      re-INSERT of a revoked hash is the only way back, and createForLogin always uses a fresh ID.
{
  const jar = new Jar(); await login(jar); const s1 = sidOf(jar);
  await call(jar, 'POST', '/api/v1/auth/logout');
  await login(jar); const s2 = sidOf(jar);
  check('R8', 'login after logout yields a different, fresh session ID', s1 !== s2 && (await rowCount(s1)) === 0 && (await rowCount(s2)) === 1);
}

const groups = [...new Set(results.map((r) => r.group))];
for (const grp of groups) for (const r of results.filter((x) => x.group === grp)) console.log(r.ok ? 'PASS' : 'FAIL', `[${grp}]`, r.name, r.ok ? '' : `(${r.detail})`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
await pool.end();
process.exit(passed === results.length ? 0 : 1);
