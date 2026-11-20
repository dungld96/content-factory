// M7 circuit breaker tables under direct SQL, as the runtime role (M7 design §7): a circuit is
// reset, never removed; an open circuit knows when to try again; only a half-open circuit has a
// trial job; transitions are append-only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const PROV = '50000000-0000-7000-8000-000000000001';
const JOB = '61000000-0000-7000-8000-000000000001';
const EV = '69000000-0000-7000-8000-000000000001';

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await commit(
    app,
    `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES ('${PROV}', 'mock', 'M', 'mock', now());
     INSERT INTO provider_circuits (provider_id, updated_at) VALUES ('${PROV}', now());
     INSERT INTO provider_circuit_events (id, provider_id, from_state, to_state, reason)
       VALUES ('${EV}', '${PROV}', 'closed', 'open', 'manual');`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('provider circuits', () => {
  it('are never deleted', async () => {
    expect(await fails(`DELETE FROM provider_circuits WHERE provider_id = '${PROV}'`)).toBe(
      'AC011',
    );
  });

  it('know when an open circuit may be tried again, and only half-open ones have a trial', async () => {
    expect(await fails(`UPDATE provider_circuits SET state = 'open'`)).toBe('23514');
    expect(
      await fails(
        `UPDATE provider_circuits SET state = 'open', opened_at = now(), retry_at = now()`,
      ),
    ).toBeNull();
    expect(
      await fails(`UPDATE provider_circuits SET trial_job_id = '${JOB}', trial_started_at = now()`),
    ).toBe('23514');
    expect(
      await fails(`UPDATE provider_circuits SET state = 'half_open', opened_at = now(), retry_at = now(),
        trial_job_id = '${JOB}', trial_started_at = now()`),
    ).toBeNull();
    expect(await fails(`UPDATE provider_circuits SET consecutive_failures = -1`)).toBe('23514');
  });
});

describe('provider circuit events', () => {
  it('are append-only, with a known reason', async () => {
    expect(
      await fails(`UPDATE provider_circuit_events SET reason = 'trial' WHERE id = '${EV}'`),
    ).toBe('AC011');
    expect(await fails(`DELETE FROM provider_circuit_events WHERE id = '${EV}'`)).toBe('AC011');
    expect(
      await fails(`INSERT INTO provider_circuit_events (id, provider_id, from_state, to_state, reason)
        VALUES ('${EV.replace(/1$/, '2')}', '${PROV}', 'open', 'closed', 'because')`),
    ).toBe('23514');
  });
});
