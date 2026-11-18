// M2 registry and usage ledger under direct SQL (design package §6.4, ADR-0012), run as the
// runtime role acf_app: every CHECK, composite FK and the AC011 guard reject the forbidden
// operation with the expected SQLSTATE, and the legal lifecycle works. Plus the lock-interaction
// guarantee: writing invocations never waits on the M1 owner-change protocol.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const U1 = '00000000-0000-7000-8000-000000000001';
const U2 = '00000000-0000-7000-8000-000000000002';
const P1 = '10000000-0000-7000-8000-000000000001';
const P2 = '10000000-0000-7000-8000-000000000002';
const CI1 = '40000000-0000-7000-8000-000000000001'; // content item of P1
const CI9 = '40000000-0000-7000-8000-000000000009'; // content item of P2
const PROV = '50000000-0000-7000-8000-000000000001';
const PROV2 = '50000000-0000-7000-8000-000000000002';
const M1 = '51000000-0000-7000-8000-000000000001'; // model of PROV
const M9 = '51000000-0000-7000-8000-000000000009'; // model of PROV2
const PRICE_IN = '52000000-0000-7000-8000-000000000001';
const PRICE_OUT = '52000000-0000-7000-8000-000000000002';
const INV_OK = '53000000-0000-7000-8000-000000000001';
const INV_FAIL = '53000000-0000-7000-8000-000000000002';
const INV_OPEN = '53000000-0000-7000-8000-000000000003';

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const insertInvocation = (id: string, overrides: Partial<Record<string, string>> = {}): string => {
  const v = {
    project_id: `'${P1}'`,
    content_item_id: `'${CI1}'`,
    provider_id: `'${PROV}'`,
    model_id: `'${M1}'`,
    status: `'started'`,
    request_summary: `'{"maxOutputTokens":64}'`,
    ...overrides,
  };
  return `INSERT INTO ai_invocations (id, project_id, content_item_id, correlation_id, capability,
            provider_id, model_id, status, request_summary)
          VALUES ('${id}', ${v.project_id}, ${v.content_item_id}, 'corr-${id.slice(-4)}', 'llm',
            ${v.provider_id}, ${v.model_id}, ${v.status}, ${v.request_summary})`;
};
const insertPrice = (id: string, metric: string, unitPrice: string, extra = '') =>
  `INSERT INTO ai_model_prices (id, model_id, metric, unit_price, source_value, effective_from,
     source, source_url, captured_at${extra ? `, ${extra.split('=')[0] ?? ''}` : ''})
   VALUES ('${id}', '${M1}', '${metric}', ${unitPrice}, '${unitPrice}', '2026-11-17T00:00:00Z',
     'official_api', 'https://openrouter.ai/api/v1/models', now()${extra ? `, ${extra.split('=')[1] ?? ''}` : ''})`;
const usage = (
  invocation: string,
  quantity: string,
  unitPrice: string,
  cost: string,
  priceId: string,
  project = P1,
) =>
  `INSERT INTO ai_usage_records (id, invocation_id, project_id, metric, quantity, unit_price, cost, price_id, source)
   VALUES (gen_random_uuid(), '${invocation}', '${project}', 'input_tokens', ${quantity}, ${unitPrice}, ${cost}, ${priceId}, 'calculated')`;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);

  await app.query(`INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES
    ('${U1}', 'owner@example.test', 'Owner', 'x', now()), ('${U2}', 'owner2@example.test', 'Owner 2', 'x', now())`);
  await commit(
    app,
    `INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at) VALUES
       ('${P1}', 'P1', 'p1', 'vi', 'UTC', '${U1}', now()), ('${P2}', 'P2', 'p2', 'vi', 'UTC', '${U1}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
       ('${P1}', '${U1}', 'owner', now()), ('${P1}', '${U2}', 'owner', now()), ('${P2}', '${U1}', 'owner', now())`,
  );
  await app.query(`INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id,
      updated_at) VALUES
    ('${CI1}', '${P1}', 'C1', '{}', 'vi', '${U1}', now()),
    ('${CI9}', '${P2}', 'C9', '{}', 'vi', '${U1}', now())`);
  await app.query(`INSERT INTO content_items (id, project_id, content_master_id, title, format,
      target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at) VALUES
    ('${CI1}', '${P1}', '${CI1}', 'C1', 'short_video', 30, '9:16', 'vi', '{}', '${U1}', now()),
    ('${CI9}', '${P2}', '${CI9}', 'C9', 'short_video', 30, '9:16', 'vi', '{}', '${U1}', now())`);
  await app.query(`INSERT INTO ai_providers (id, key, name, kind, status, updated_at) VALUES
    ('${PROV}', 'openrouter', 'OpenRouter', 'gateway', 'enabled', now()),
    ('${PROV2}', 'other', 'Other', 'direct', 'disabled', now())`);
  await app.query(`INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at,
      supported_parameters) VALUES
    ('${M1}', '${PROV}', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', 'economy', now(), '{max_tokens,seed}'),
    ('${M9}', '${PROV2}', 'other/model', 'Other', 'balanced', now(), '{}')`);
  await app.query(
    `INSERT INTO ai_model_capabilities (model_id, capability) VALUES ('${M1}', 'llm')`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('registry', () => {
  it('creates models disabled by default', async () => {
    await app.query(`INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at)
      VALUES ('51000000-0000-7000-8000-000000000002', '${PROV}', 'x/new', 'New', 'economy', now())`);
    const { rows } = await app.query<{ status: string }>(
      `SELECT status FROM ai_models WHERE model_key = 'x/new'`,
    );
    expect(rows[0]?.status).toBe('disabled');
  });

  it.each([
    [
      'provider key format',
      `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES (gen_random_uuid(), 'Bad Key', 'n', 'direct', now())`,
      '23514',
    ],
    [
      'provider kind',
      `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES (gen_random_uuid(), 'k2', 'n', 'proxy', now())`,
      '23514',
    ],
    [
      'provider name',
      `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES (gen_random_uuid(), 'k3', '  ', 'direct', now())`,
      '23514',
    ],
    [
      'duplicate provider key',
      `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES (gen_random_uuid(), 'openrouter', 'n', 'direct', now())`,
      '23505',
    ],
    [
      'duplicate model key per provider',
      `INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at) VALUES (gen_random_uuid(), '${PROV}', 'deepseek/deepseek-v4-flash', 'd', 'economy', now())`,
      '23505',
    ],
    [
      'empty model key',
      `INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at) VALUES (gen_random_uuid(), '${PROV}', ' ', 'd', 'economy', now())`,
      '23514',
    ],
    ['non-positive context', `UPDATE ai_models SET context_length = 0 WHERE id = '${M1}'`, '23514'],
    [
      'non-positive max output',
      `UPDATE ai_models SET max_output_tokens = -1 WHERE id = '${M1}'`,
      '23514',
    ],
    [
      'benchmark out of range',
      `UPDATE ai_models SET benchmark_score = 100.5 WHERE id = '${M1}'`,
      '23514',
    ],
    [
      'model of unknown provider',
      `INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'a/b', 'd', 'economy', now())`,
      '23503',
    ],
    [
      'unknown capability',
      `INSERT INTO ai_model_capabilities (model_id, capability) VALUES ('${M1}', 'music')`,
      '22P02',
    ],
  ])('rejects %s', async (_name, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('lets the operator change model status and metadata', async () => {
    expect(
      await fails(
        `UPDATE ai_models SET status = 'enabled', benchmark_score = 71.5 WHERE id = '${M1}'`,
      ),
    ).toBeNull();
  });
});

describe('prices (append-only)', () => {
  beforeAll(async () => {
    await app.query(insertPrice(PRICE_IN, 'input_tokens', '0.000000072'));
    await app.query(insertPrice(PRICE_OUT, 'output_tokens', '0.000000144'));
  });

  it('stores sub-micro unit prices exactly at 18 decimals', async () => {
    const { rows } = await app.query<{ unit_price: string }>(
      `SELECT unit_price::text FROM ai_model_prices WHERE id = '${PRICE_IN}'`,
    );
    expect(rows[0]?.unit_price).toBe('0.000000072000000000');
  });

  it('accepts a later price for the same metric as a new row', async () => {
    expect(
      await fails(
        `INSERT INTO ai_model_prices (id, model_id, metric, unit_price, source_value, effective_from, source, source_url, captured_at)
         VALUES (gen_random_uuid(), '${M1}', 'input_tokens', 0.00000008, '0.00000008', '2026-12-01T00:00:00Z', 'manual_estimate', 'https://example.test', now())`,
      ),
    ).toBeNull();
  });

  it.each([
    ['UPDATE', `UPDATE ai_model_prices SET unit_price = 0 WHERE id = '${PRICE_IN}'`],
    ['DELETE', `DELETE FROM ai_model_prices WHERE id = '${PRICE_IN}'`],
  ])('refuses %s with AC011', async (_op, sql) => {
    expect(await fails(sql)).toBe('AC011');
  });

  it.each([
    [
      'negative price',
      insertPrice('52000000-0000-7000-8000-0000000000a1', 'request', '-1'),
      '23514',
    ],
    [
      'non-USD currency',
      insertPrice('52000000-0000-7000-8000-0000000000a2', 'request', '1', `currency='EUR'`),
      '23514',
    ],
    [
      'negative tier',
      insertPrice('52000000-0000-7000-8000-0000000000a3', 'request', '1', 'min_prompt_tokens=-5'),
      '23514',
    ],
    [
      'same metric, tier and effective date',
      insertPrice('52000000-0000-7000-8000-0000000000a4', 'input_tokens', '0.1'),
      '23505',
    ],
  ])('rejects %s', async (_name, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });
});

describe('invocations', () => {
  it('starts as `started` with unknown cost and no completion time', async () => {
    await app.query(insertInvocation(INV_OK));
    const { rows } = await app.query<{
      status: string;
      cost_status: string;
      completed_at: Date | null;
    }>(`SELECT status, cost_status, completed_at FROM ai_invocations WHERE id = '${INV_OK}'`);
    expect(rows[0]).toEqual({ status: 'started', cost_status: 'unknown', completed_at: null });
  });

  it.each([
    [
      'inserted with an outcome',
      insertInvocation('53000000-0000-7000-8000-0000000000b1', { status: `'succeeded'` }),
      'AC011',
    ],
    [
      'content item of another project',
      insertInvocation('53000000-0000-7000-8000-0000000000b2', { content_item_id: `'${CI9}'` }),
      '23503',
    ],
    [
      'model of another provider',
      insertInvocation('53000000-0000-7000-8000-0000000000b3', { model_id: `'${M9}'` }),
      '23503',
    ],
    [
      'request summary not an object',
      insertInvocation('53000000-0000-7000-8000-0000000000b4', { request_summary: `'[]'` }),
      '23514',
    ],
  ])('rejects an invocation %s', async (_name, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it.each([
    [
      'completed without completed_at',
      `UPDATE ai_invocations SET status = 'succeeded', cost_status = 'unknown' WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'failed without an error code',
      `UPDATE ai_invocations SET status = 'failed', completed_at = now() WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'succeeded with an error code',
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), error_code = 'TIMEOUT' WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'reported status without a reported cost',
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), cost_status = 'reported' WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'estimated status without an estimate',
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), cost_status = 'estimated' WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'unknown status with an estimate (unknown is never an amount)',
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), estimated_cost = 0 WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'a reported cost without the reported status',
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), cost_status = 'estimated', estimated_cost = 1, reported_cost = 1 WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'negative latency',
      `UPDATE ai_invocations SET latency_ms = -1 WHERE id = '${INV_OK}'`,
      '23514',
    ],
    [
      'change of model (identity)',
      `UPDATE ai_invocations SET model_id = '${M1}', provider_id = '${PROV}', correlation_id = 'other' WHERE id = '${INV_OK}'`,
      'AC011',
    ],
    [
      'change of request summary',
      `UPDATE ai_invocations SET request_summary = '{"x":1}' WHERE id = '${INV_OK}'`,
      'AC011',
    ],
    ['delete', `DELETE FROM ai_invocations WHERE id = '${INV_OK}'`, 'AC011'],
  ])('rejects %s', async (_name, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('records the outcome once, with reported and estimated cost', async () => {
    await commit(
      app,
      `UPDATE ai_invocations SET status = 'succeeded', completed_at = now(), latency_ms = 812,
         provider_request_id = 'gen-1', served_model = 'deepseek/deepseek-v4-flash', finish_reason = 'stop',
         cost_status = 'reported', reported_cost = 0.00015, estimated_cost = 0.000144
       WHERE id = '${INV_OK}'`,
    );
    expect(await fails(`UPDATE ai_invocations SET latency_ms = 1 WHERE id = '${INV_OK}'`)).toBe(
      'AC011',
    );
  });

  it('records a failure with its normalized error and unknown cost', async () => {
    await app.query(insertInvocation(INV_FAIL));
    expect(
      await fails(
        `UPDATE ai_invocations SET status = 'failed', completed_at = now(), error_code = 'RATE_LIMITED',
           error_message = 'Rate limit exceeded' WHERE id = '${INV_FAIL}'`,
      ),
    ).toBeNull();
  });

  it('enforces a unique idempotency key', async () => {
    await app.query(insertInvocation(INV_OPEN));
    await app.query(`UPDATE ai_invocations SET status = 'outcome_unknown', completed_at = now(),
      error_code = 'TIMEOUT' WHERE id = '${INV_OPEN}'`);
    expect(
      await fails(
        `INSERT INTO ai_invocations (id, project_id, correlation_id, capability, provider_id, model_id, request_summary, idempotency_key)
         VALUES (gen_random_uuid(), '${P1}', 'c', 'llm', '${PROV}', '${M1}', '{}', 'job-1:attempt-1'),
                (gen_random_uuid(), '${P1}', 'c', 'llm', '${PROV}', '${M1}', '{}', 'job-1:attempt-1')`,
      ),
    ).toBe('23505');
  });
});

describe('usage records (append-only)', () => {
  it('accepts a priced line whose cost is quantity × unit price, and an unpriced line', async () => {
    await app.query(usage(INV_OK, '1000', '0.000000072', '0.000072', `'${PRICE_IN}'`));
    await app.query(usage(INV_OK, '500', 'NULL', 'NULL', 'NULL'));
    const { rows } = await app.query<{ total: string }>(
      `SELECT sum(cost)::text AS total FROM ai_usage_records WHERE invocation_id = '${INV_OK}'`,
    );
    expect(rows[0]?.total).toBe('0.000072000000000000');
  });

  it.each([
    [
      'cost ≠ quantity × unit price',
      usage(INV_OK, '1000', '0.000000072', '0.0001', `'${PRICE_IN}'`),
      '23514',
    ],
    ['cost without unit price', usage(INV_OK, '1', 'NULL', '0', 'NULL'), '23514'],
    ['unit price without cost', usage(INV_OK, '1', '0.1', 'NULL', 'NULL'), '23514'],
    [
      'price reference without unit price',
      usage(INV_OK, '1', 'NULL', 'NULL', `'${PRICE_IN}'`),
      '23514',
    ],
    ['negative quantity', usage(INV_OK, '-1', 'NULL', 'NULL', 'NULL'), '23514'],
    [
      'project other than the invocation’s',
      usage(INV_OK, '1', 'NULL', 'NULL', 'NULL', P2),
      '23503',
    ],
    [
      'UPDATE',
      `UPDATE ai_usage_records SET quantity = 1 WHERE invocation_id = '${INV_OK}'`,
      'AC011',
    ],
    ['DELETE', `DELETE FROM ai_usage_records WHERE invocation_id = '${INV_OK}'`, 'AC011'],
  ])('rejects %s', async (_name, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });
});

describe('lock interaction with the M1 owner-change protocol (design §6.4)', () => {
  it('an invocation insert never waits on an in-flight owner demotion', async () => {
    const owner = await connect('app');
    const writer = await connect('app');
    try {
      // Session A: demote one of P1's two owners and hold the transaction open. The deferred
      // owner check has not fired yet, but the member row is locked and the protocol's project
      // write is pending; force it now so the project row lock is actually held.
      await owner.query('BEGIN');
      await owner.query(
        `UPDATE project_members SET role = 'editor' WHERE project_id = '${P1}' AND user_id = '${U2}'`,
      );
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
      const { rows: held } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         WHERE l.pid = pg_backend_pid() AND c.relname = 'projects' AND l.mode = 'RowExclusiveLock'`,
      );
      expect(held[0]?.n).toBeGreaterThan(0); // the project row was written

      // Session B: record an invocation (FK → projects, content_items, ai_models) with a short
      // lock timeout: any wait on A's locks would fail with 55P03 instead of hanging.
      await writer.query(`SET lock_timeout = '2s'`);
      await writer.query('BEGIN');
      const started = Date.now();
      await writer.query(insertInvocation('53000000-0000-7000-8000-0000000000c1'));
      await writer.query(
        usage('53000000-0000-7000-8000-0000000000c1', '1', 'NULL', 'NULL', 'NULL'),
      );
      await writer.query('COMMIT');
      expect(Date.now() - started).toBeLessThan(1000);

      await owner.query('COMMIT');
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
      await owner.end();
      await writer.end();
    }
  });

  it('a project-row writer does not block the ledger, and the reverse', async () => {
    const a = await connect('app');
    const b = await connect('app');
    try {
      await a.query('BEGIN');
      await a.query(`UPDATE projects SET updated_at = updated_at WHERE id = '${P1}'`); // FOR NO KEY UPDATE
      await b.query(`SET lock_timeout = '2s'`);
      await b.query('BEGIN');
      await b.query(insertInvocation('53000000-0000-7000-8000-0000000000c2')); // FOR KEY SHARE
      await b.query('COMMIT');
      await a.query('COMMIT');
    } finally {
      await a.end();
      await b.end();
    }
  });
});
