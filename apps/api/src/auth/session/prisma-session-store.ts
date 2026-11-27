import { createHash } from 'node:crypto';

import session from 'express-session';

import type { PrismaClient } from '@acf/database';

import './session.types.js';

/** Lookup key: SHA-256 of the express-session ID. The raw ID is never stored. */
export const hashSessionId = (sid: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(sid, 'utf8').digest());

type Callback<T = void> = (err?: unknown, value?: T) => void;

export interface PrismaSessionStoreOptions {
  /** Hard upper bound on a session's lifetime (D5: 7 days). */
  readonly absoluteTtlMs: number;
  /** Fallback idle TTL when the cookie carries no expiry (D5: 24 hours). */
  readonly idleTtlMs: number;
  /** Skip `touch` writes when the row was seen more recently than this. */
  readonly touchThrottleMs: number;
  /** Injected clock: the single time source for every expiry comparison. */
  readonly now?: () => Date;
  /** Observability hook (tests assert on it). Must not throw. */
  readonly onEvent?: (event: SessionStoreEvent) => void;
}

export type SessionStoreEvent =
  | { readonly type: 'created' }
  | { readonly type: 'set'; readonly updated: boolean; readonly reason?: 'unauthenticated' }
  | { readonly type: 'touch'; readonly updated: boolean }
  | { readonly type: 'destroyed' }
  | { readonly type: 'revoked_all'; readonly count: number };

/** Persisted payload: allow-listed fields only. */
interface PersistedSession {
  readonly cookie: session.Cookie;
  readonly userId: string;
  readonly authenticatedAt: string;
}

const errorOf = (error: unknown): Error =>
  error instanceof Error ? error : new Error('session store failure');

/**
 * Persistence-only express-session Store backed by Prisma 7 (ADR-0009 D2; design package §5.3).
 * Session IDs, cookie signing, regeneration and destroy semantics stay in express-session.
 *
 * Revocation safety: rows are created ONLY by {@link createForLogin}, which the login handler
 * calls right after `session.regenerate()` for a brand-new, never-disclosed ID. `set` and
 * `touch` are UPDATE-only, so a request that loaded a session before logout and saves it
 * afterwards matches zero rows and cannot recreate it. UPDATE and DELETE on the same row are
 * serialized by PostgreSQL's row lock (verified: packages/database concurrency S1–S3).
 *
 * INVARIANT: any second creation path reopens ADR-0009 (no tombstone table exists).
 */
export class PrismaSessionStore extends session.Store {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: PrismaSessionStoreOptions,
  ) {
    super();
    this.now = options.now ?? (() => new Date());
  }

  /** The ONLY insert path. Call once per login, after `req.session.regenerate()`. */
  async createForLogin(sid: string, sess: session.SessionData): Promise<void> {
    const payload = toPersisted(sess);
    const now = this.now();
    const absoluteExpiresAt = new Date(now.getTime() + this.options.absoluteTtlMs);
    await this.prisma.session.create({
      data: {
        idHash: hashSessionId(sid),
        userId: payload.userId,
        data: JSON.parse(JSON.stringify(payload)) as object,
        expiresAt: minDate(this.idleExpiry(sess, now), absoluteExpiresAt),
        absoluteExpiresAt,
        createdAt: now,
        lastSeenAt: now,
      },
    });
    this.options.onEvent?.({ type: 'created' });
  }

  override get(sid: string, cb: Callback<session.SessionData | null>): void {
    const now = this.now();
    this.prisma.session
      .findFirst({
        where: {
          idHash: hashSessionId(sid),
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        select: { data: true },
      })
      .then(
        (row) => {
          cb(null, row ? (row.data as unknown as session.SessionData) : null);
        },
        (error: unknown) => {
          cb(errorOf(error));
        },
      );
  }

  /** UPDATE-only. Never inserts. A missing, revoked or expired row is a silent no-op. */
  override set(sid: string, sess: session.SessionData, cb?: Callback): void {
    const payload = toPersistedOrNull(sess);
    if (!payload) {
      // Anonymous sessions are never persisted (saveUninitialized=false). No-op, not an error.
      this.options.onEvent?.({ type: 'set', updated: false, reason: 'unauthenticated' });
      cb?.();
      return;
    }
    const now = this.now();
    this.prisma.$executeRaw`
        UPDATE sessions
           SET data = ${JSON.stringify(payload)}::jsonb,
               expires_at = LEAST(${this.idleExpiry(sess, now)}::timestamptz, absolute_expires_at),
               last_seen_at = ${now}::timestamptz
         WHERE id_hash = ${hashSessionId(sid)}
           AND user_id = ${payload.userId}::uuid
           AND expires_at > ${now}::timestamptz
           AND absolute_expires_at > ${now}::timestamptz`.then(
      (count) => {
        this.options.onEvent?.({ type: 'set', updated: count === 1 });
        cb?.();
      },
      (error: unknown) => {
        cb?.(errorOf(error));
      },
    );
  }

  /** UPDATE-only, throttled to one write per `touchThrottleMs`. */
  override touch(sid: string, sess: session.SessionData, cb?: Callback): void {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.options.touchThrottleMs);
    this.prisma.$executeRaw`
        UPDATE sessions
           SET expires_at = LEAST(${this.idleExpiry(sess, now)}::timestamptz, absolute_expires_at),
               last_seen_at = ${now}::timestamptz
         WHERE id_hash = ${hashSessionId(sid)}
           AND expires_at > ${now}::timestamptz
           AND absolute_expires_at > ${now}::timestamptz
           AND last_seen_at <= ${staleBefore}::timestamptz`.then(
      (count) => {
        this.options.onEvent?.({ type: 'touch', updated: count === 1 });
        cb?.();
      },
      (error: unknown) => {
        cb?.(errorOf(error));
      },
    );
  }

  override destroy(sid: string, cb?: Callback): void {
    this.prisma.session.deleteMany({ where: { idHash: hashSessionId(sid) } }).then(
      () => {
        this.options.onEvent?.({ type: 'destroyed' });
        cb?.();
      },
      (error: unknown) => {
        cb?.(errorOf(error));
      },
    );
  }

  /** Password change / account disable: revoke every session of the user. */
  async destroyAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({ where: { userId } });
    this.options.onEvent?.({ type: 'revoked_all', count });
    return count;
  }

  /** Housekeeping only; correctness never depends on it. */
  async pruneExpired(): Promise<number> {
    const now = this.now();
    const { count } = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lte: now } }, { absoluteExpiresAt: { lte: now } }] },
    });
    return count;
  }

  private idleExpiry(sess: session.SessionData, now: Date): Date {
    // Reading the computed cookie expiry is intended; the deprecation is about *setting* it
    // instead of `maxAge`.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const expires = sess.cookie.expires;
    return expires ? new Date(expires) : new Date(now.getTime() + this.options.idleTtlMs);
  }
}

function toPersistedOrNull(sess: session.SessionData): PersistedSession | null {
  return sess.userId && sess.authenticatedAt
    ? { cookie: sess.cookie, userId: sess.userId, authenticatedAt: sess.authenticatedAt }
    : null;
}

function toPersisted(sess: session.SessionData): PersistedSession {
  const payload = toPersistedOrNull(sess);
  if (!payload) throw new Error('createForLogin requires userId and authenticatedAt');
  return payload;
}

const minDate = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);
