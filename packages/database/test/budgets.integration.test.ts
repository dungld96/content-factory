// M7 budgets under direct SQL, as the runtime role (M7 design §4): a budget is changed, never
// removed; budget events are append-only; a reservation is created open, keeps its amount and
// job, only moves forward (open → settled | released | held, held → settled | released) and is
// never deleted.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const U = '00000000-0000-7000-8000-000000000001';
const P = '10000000-0000-7000-8000-000000000001';
const CI = '40000000-0000-7000-8000-000000000001';
const PROV = '50000000-0000-7000-8000-000000000001';
const MODEL = '51000000-0000-7000-8000-000000000001';
const RUN = '60000000-0000-7000-8000-000000000001';
const J1 = '61000000-0000-7000-8000-000000000001';
const J2 = '61000000-0000-7000-8000-000000000002';
const J3 = '61000000-0000-7000-8000-000000000003';
const R1 = '67000000-0000-7000-8000-000000000001';
const R2 = '67000000-0000-7000-8000-000000000002';
const R3 = '67000000-0000-7000-8000-000000000003';
const E1 = '68000000-0000-7000-8000-000000000001';
const KEY = 'a'.repeat(64);

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const job = (id: string, kind: string) =>
  `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
     active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
     model_id, requested_by_id, updated_at)
   VALUES ('${id}', '${P}', '${CI}', '${RUN}', '${kind}', 'queued', 0, '${CI}:${kind}', 'idem-${kind}',
     '${KEY}', '{}', 'draft', '${kind}.v1', '${MODEL}', '${U}', now())`;
const reservation = (id: string, jobId: string, status = 'open') =>
  `INSERT INTO budget_reservations (id, project_id, content_item_id, job_id, amount_usd, kind, status, updated_at)
   VALUES ('${id}', '${P}', '${CI}', '${jobId}', 0.25, 'estimate', '${status}', now())`;
const move = (id: string, status: string) =>
  `UPDATE budget_reservations SET status = '${status}',
     resolved_at = CASE WHEN '${status}' IN ('open', 'held') THEN NULL ELSE now() END WHERE id = '${id}'`;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await commit(
    app,
    `INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES ('${U}', 'u@example.test', 'U', 'x', now());
     INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
       VALUES ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES ('${P}', '${U}', 'owner', now());
     INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
       VALUES ('${CI}', '${P}', 'C', '{}', 'vi', '${U}', now());
     INSERT INTO content_items (id, project_id, content_master_id, title, format, target_duration_seconds,
         aspect_ratio, language, brief, created_by_id, updated_at)
       VALUES ('${CI}', '${P}', '${CI}', 'C', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now());
     INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES ('${PROV}', 'mock', 'M', 'mock', now());
     INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at)
       VALUES ('${MODEL}', '${PROV}', 'mock/x', 'X', 'economy', now());
     INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
       VALUES ('${RUN}', '${P}', '${CI}', '${U}', now());
     ${job(J1, 'script_generation')}; ${job(J2, 'storyboard_generation')}; ${job(J3, 'render')};
     INSERT INTO project_budgets (project_id, monthly_limit_usd, updated_at) VALUES ('${P}', 10, now());
     INSERT INTO budget_events (id, project_id, actor_id, type, detail)
       VALUES ('${E1}', '${P}', '${U}', 'changed', '{}');
     ${reservation(R1, J1)}; ${reservation(R2, J2)}; ${reservation(R3, J3)};`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('project budgets', () => {
  it('are changed, never removed, and never negative', async () => {
    expect(
      await fails(`UPDATE project_budgets SET monthly_limit_usd = 20 WHERE project_id = '${P}'`),
    ).toBeNull();
    expect(await fails(`DELETE FROM project_budgets WHERE project_id = '${P}'`)).toBe('AC011');
    expect(
      await fails(`UPDATE project_budgets SET request_limit_usd = -1 WHERE project_id = '${P}'`),
    ).toBe('23514');
  });
});

describe('budget events', () => {
  it('are append-only, with a known type', async () => {
    expect(await fails(`UPDATE budget_events SET type = 'override' WHERE id = '${E1}'`)).toBe(
      'AC011',
    );
    expect(await fails(`DELETE FROM budget_events WHERE id = '${E1}'`)).toBe('AC011');
    expect(
      await fails(
        `INSERT INTO budget_events (id, project_id, type, detail) VALUES ('${E1.replace(/1$/, '2')}', '${P}', 'spent', '{}')`,
      ),
    ).toBe('23514');
  });
});

describe('budget reservations', () => {
  it('are created open, one per job, never deleted', async () => {
    expect(await fails(reservation('67000000-0000-7000-8000-000000000009', J1))).toBe('23505');
    expect(await fails(`DELETE FROM budget_reservations WHERE id = '${R1}'`)).toBe('AC011');
  });

  it('keep their amount and job', async () => {
    expect(await fails(`UPDATE budget_reservations SET amount_usd = 0 WHERE id = '${R1}'`)).toBe(
      'AC011',
    );
    expect(await fails(`UPDATE budget_reservations SET job_id = '${J2}' WHERE id = '${R1}'`)).toBe(
      'AC011',
    );
  });

  it('only move forward, with resolved_at set exactly when resolved', async () => {
    expect(
      await fails(`UPDATE budget_reservations SET status = 'settled' WHERE id = '${R1}'`),
    ).toBe('23514');
    await commit(app, move(R1, 'settled'));
    expect(await fails(move(R1, 'open'))).toBe('AC011');
    expect(await fails(move(R1, 'released'))).toBe('AC011');
    await commit(app, move(R2, 'held'));
    expect(await fails(move(R2, 'open'))).toBe('AC011');
    expect(await fails(move(R2, 'released'))).toBeNull();
    expect(await fails(move(R2, 'settled'))).toBeNull();
    await commit(app, move(R3, 'released'));
    expect(await fails(move(R3, 'held'))).toBe('AC011');
  });

  it('record a settled charge only when a held reservation is settled, then freeze it', async () => {
    // R1 went open → settled: no charge may be added afterwards.
    expect(
      await fails(`UPDATE budget_reservations SET settled_charge_usd = 0.25 WHERE id = '${R1}'`),
    ).toBe('AC011');
    // R2 is still held (the transitions tried on it above were rolled back).
    expect(
      await fails(`UPDATE budget_reservations SET settled_charge_usd = 0.25 WHERE id = '${R2}'`),
    ).toBe('AC011');
    await commit(
      app,
      `UPDATE budget_reservations SET status = 'settled', resolved_at = now(), settled_charge_usd = 0.25 WHERE id = '${R2}'`,
    );
    expect(
      await fails(`UPDATE budget_reservations SET settled_charge_usd = 0.3 WHERE id = '${R2}'`),
    ).toBe('AC011');
  });
});

describe('production runs (M7c)', () => {
  it('link the run they resumed once, never themselves', async () => {
    const RUN2 = '60000000-0000-7000-8000-000000000002';
    await commit(
      app,
      `INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
         VALUES ('${RUN2}', '${P}', '${CI}', '${U}', now())`,
    );
    expect(
      await fails(
        `UPDATE production_runs SET resumed_from_run_id = '${RUN2}' WHERE id = '${RUN2}'`,
      ),
    ).toBe('23514');
    await commit(
      app,
      `UPDATE production_runs SET resumed_from_run_id = '${RUN}' WHERE id = '${RUN2}'`,
    );
    expect(
      await fails(`UPDATE production_runs SET resumed_from_run_id = NULL WHERE id = '${RUN2}'`),
    ).toBe('AC011');
  });
});
