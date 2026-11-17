import { createHash } from 'node:crypto';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://localhost:3100'; // through the Next.js proxy
const ORIGIN = 'http://localhost:3100';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const results = [];
const check = (name, ok, detail = '') => results.push({ ok: !!ok, name, detail });

class Jar { c = new Map(); store(res) { for (const sc of res.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) this.c.delete(k); else this.c.set(k, v); } } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); } }
async function call(jar, method, path, body, extra = {}) {
  const res = await fetch(BASE + path, { method, redirect: 'manual', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(jar ? { cookie: jar.header() } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  jar?.store(res);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}
const sidOf = (jar) => decodeURIComponent(jar.c.get('acf_sid') ?? jar.c.get('__Host-acf_sid') ?? '').replace(/^s:/, '').split('.')[0];
const hash = (sid) => createHash('sha256').update(sid).digest();

// 1. login + cookie attributes
const a = new Jar();
const login = await call(a, 'POST', '/api/v1/auth/login', { email: 'owner@example.test' });
const sc = login.setCookie.find((c) => c.startsWith('acf_sid=')) ?? '';
check('login 200 through Next rewrite', login.status === 200, login.status);
check('Set-Cookie forwarded by Next rewrite', sc.length > 0, sc.replace(/=s%3A[^;]+/, '=s%3A<redacted>'));
check('cookie HttpOnly + SameSite=Lax + Path=/, no Domain', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && !/Domain=/i.test(sc));
check('me 200 with session', (await call(a, 'GET', '/api/v1/auth/me')).status === 200);

// 2. DB holds only the hash + minimal payload
const sid = sidOf(a);
const row = (await pool.query('SELECT encode(id_hash, $2) AS h, data, user_id, absolute_expires_at - created_at AS abs FROM sessions WHERE id_hash = $1', [hash(sid), 'hex'])).rows[0];
check('row keyed by sha256(sid)', !!row);
check('raw sid not stored anywhere in row', row && !JSON.stringify(row).includes(sid));
check('payload keys are allow-listed', row && JSON.stringify(Object.keys(row.data).sort()) === '["authenticatedAt","cookie","userId"]', row && Object.keys(row.data));

// 3. CSRF
check('mutate without CSRF token -> 403', (await call(a, 'POST', '/api/v1/mutate', {})).status === 403);
check('mutate with CSRF token -> 200', (await call(a, 'POST', '/api/v1/mutate', {}, { 'x-csrf-token': login.json.csrfToken })).status === 200);
check('mutate with forged token -> 403', (await call(a, 'POST', '/api/v1/mutate', {}, { 'x-csrf-token': 'x' + login.json.csrfToken.slice(1) })).status === 403);

// 4. session fixation: login while presenting an existing session cookie -> new ID, old row gone
const before = sidOf(a);
await call(a, 'POST', '/api/v1/auth/login', { email: 'editor@example.test' });
const after = sidOf(a);
check('fixation: session ID changes on login', before && after && before !== after);
check('fixation: previous session row deleted', (await pool.query('SELECT 1 FROM sessions WHERE id_hash = $1', [hash(before)])).rowCount === 0);
const stale = new Jar(); stale.c.set('acf_sid', encodeURIComponent('s:') + before + '.x');
check('old/forged cookie value -> 401', (await call(stale, 'GET', '/api/v1/auth/me')).status === 401);

// 5. logout revokes immediately, and a concurrent in-flight request cannot resurrect it
const b = new Jar(); await call(b, 'POST', '/api/v1/auth/login', { email: 'owner@example.test' });
const copy = new Jar(); copy.c = new Map(b.c); // attacker/other tab holding the same cookie
const slow = call(copy, 'GET', '/api/v1/auth/slow'); // in flight across logout
await new Promise((r) => setTimeout(r, 200));
const out = await call(b, 'POST', '/api/v1/auth/logout');
check('logout 204', out.status === 204);
check('logout clears cookie', out.setCookie.some((c) => /acf_sid=;/.test(c)));
await slow;
check('same cookie after logout -> 401', (await call(copy, 'GET', '/api/v1/auth/me')).status === 401);
check('no session row resurrected by concurrent request', (await pool.query('SELECT 1 FROM sessions WHERE id_hash = $1', [hash(sidOf(copy))])).rowCount === 0);

// 6. concurrent authenticated requests on one session
const c = new Jar(); await call(c, 'POST', '/api/v1/auth/login', { email: 'owner@example.test' });
const many = await Promise.all(Array.from({ length: 20 }, () => call(c, 'GET', '/api/v1/auth/me')));
check('20 concurrent requests all 200', many.every((r) => r.status === 200), many.map((r) => r.status).join(','));
check('exactly one row for that session', (await pool.query('SELECT count(*)::int n FROM sessions WHERE id_hash = $1', [hash(sidOf(c))])).rows[0].n === 1);

// 7. expiry: idle and absolute
await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [hash(sidOf(c))]);
check('idle-expired session -> 401', (await call(c, 'GET', '/api/v1/auth/me')).status === 401);
const d = new Jar(); await call(d, 'POST', '/api/v1/auth/login', { email: 'owner@example.test' });
await pool.query(`UPDATE sessions SET absolute_expires_at = now() - interval '1 second', expires_at = now() - interval '2 second' WHERE id_hash = $1`, [hash(sidOf(d))]);
check('absolute-expired session -> 401', (await call(d, 'GET', '/api/v1/auth/me')).status === 401);
const e = new Jar(); await call(e, 'POST', '/api/v1/auth/login', { email: 'owner@example.test' });
await pool.query(`UPDATE sessions SET absolute_expires_at = now() + interval '1 hour', expires_at = now() + interval '1 hour' WHERE id_hash = $1`, [hash(sidOf(e))]);
await call(e, 'GET', '/api/v1/auth/me'); // rolling touch tries to extend idle expiry by 24h
const capped = (await pool.query(`SELECT expires_at <= absolute_expires_at AS ok FROM sessions WHERE id_hash = $1`, [hash(sidOf(e))])).rows[0];
check('rolling touch never extends past absolute expiry', capped?.ok === true);

// 8. revoke all sessions for a user (password change / disable)
const f1 = new Jar(), f2 = new Jar();
await call(f1, 'POST', '/api/v1/auth/login', { email: 'editor@example.test' });
await call(f2, 'POST', '/api/v1/auth/login', { email: 'editor@example.test' });
await pool.query(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'editor@example.test')`);
check('revoke-all: both sessions -> 401', (await call(f1, 'GET', '/api/v1/auth/me')).status === 401 && (await call(f2, 'GET', '/api/v1/auth/me')).status === 401);

// 9. invalid cookies
const rowsBefore = (await pool.query(`SELECT count(*)::int n FROM sessions`)).rows[0].n;
const g = new Jar(); g.c.set('acf_sid', 'garbage');
check('garbage cookie -> 401', (await call(g, 'GET', '/api/v1/auth/me')).status === 401);
check('unauthenticated request created no row', (await pool.query(`SELECT count(*)::int n FROM sessions`)).rows[0].n === rowsBefore);

for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', '-', r.name, r.ok ? '' : `(${r.detail})`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await pool.end();
