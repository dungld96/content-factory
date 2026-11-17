import { createHash } from 'node:crypto';

import session from 'express-session';
import type { Pool } from 'pg';

/** Lookup key: SHA-256 of the express-session ID. The raw ID is never stored. */
export const hashSid = (sid: string): Buffer => createHash('sha256').update(sid, 'utf8').digest();

type Cb<T = void> = (err?: unknown, value?: T) => void;

/**
 * Persistence-only express-session Store. ID generation, cookie signing, regeneration and
 * destroy semantics stay in express-session.
 */
export class PgHashedSessionStore extends session.Store {
  constructor(private readonly pool: Pool, private readonly absoluteTtlMs: number) {
    super();
  }

  override get(sid: string, cb: Cb<session.SessionData | null>): void {
    this.pool
      .query(
        `SELECT data FROM sessions WHERE id_hash = $1 AND expires_at > now() AND absolute_expires_at > now()`,
        [hashSid(sid)],
      )
      .then((r) => cb(null, (r.rows[0]?.data as session.SessionData | undefined) ?? null), cb);
  }

  override set(sid: string, sess: session.SessionData, cb?: Cb): void {
    const { userId, authenticatedAt } = sess;
    if (!userId) {
      cb?.(new Error('refusing to persist an unauthenticated session'));
      return;
    }
    // Allow-list: only cookie metadata + identity. Nothing else in the session is persisted.
    const data = { cookie: sess.cookie, userId, authenticatedAt };
    const expires = sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86_400_000);
    this.pool
      .query(
        `INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, LEAST($4::timestamptz, now() + $5 * interval '1 millisecond'), now() + $5 * interval '1 millisecond')
         ON CONFLICT (id_hash) DO UPDATE
           SET data = EXCLUDED.data, last_seen_at = now(),
               expires_at = LEAST(EXCLUDED.expires_at, sessions.absolute_expires_at)
           WHERE sessions.user_id = EXCLUDED.user_id`,
        [hashSid(sid), userId, JSON.stringify(data), expires, this.absoluteTtlMs],
      )
      .then(() => cb?.(), cb);
  }

  /** UPDATE only: a touch can never resurrect a destroyed session. */
  override touch(sid: string, sess: session.SessionData, cb?: Cb): void {
    const expires = sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86_400_000);
    this.pool
      .query(
        `UPDATE sessions SET expires_at = LEAST($2::timestamptz, absolute_expires_at), last_seen_at = now()
         WHERE id_hash = $1 AND expires_at > now()`,
        [hashSid(sid), expires],
      )
      .then(() => cb?.(), cb);
  }

  override destroy(sid: string, cb?: Cb): void {
    this.pool.query(`DELETE FROM sessions WHERE id_hash = $1`, [hashSid(sid)]).then(() => cb?.(), cb);
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    return r.rowCount ?? 0;
  }
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    authenticatedAt?: string;
  }
}
