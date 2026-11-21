// P1 O6: the AI registry audit under direct SQL, as the runtime role: append-only, known source
// and action, and API changes always name their operator.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const USER = '00000000-0000-7000-8000-0000000000a1';
const EV = '6a000000-0000-7000-8000-000000000001';

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);
const insert = (id: string, source: string, actor: string | null, action = 'route_set') =>
  `INSERT INTO ai_registry_events (id, actor_id, source, action, target, after)
   VALUES ('${id}', ${actor ? `'${actor}'` : 'NULL'}, '${source}', '${action}', 'script_generation', '{"modelKey":"m"}')`;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await commit(
    app,
    `INSERT INTO users (id, email, display_name, password_hash, updated_at)
       VALUES ('${USER}', 'op@example.test', 'Op', 'x', now());
     ${insert(EV, 'api', USER)};`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('AI registry events', () => {
  it('are append-only', async () => {
    expect(await fails(`UPDATE ai_registry_events SET target = 'x' WHERE id = '${EV}'`)).toBe(
      'AC011',
    );
    expect(await fails(`DELETE FROM ai_registry_events WHERE id = '${EV}'`)).toBe('AC011');
  });

  it('accept a CLI change without an actor', async () => {
    expect(await fails(insert('6a000000-0000-7000-8000-000000000002', 'cli', null))).toBeNull();
  });

  it.each([
    [
      'an API change without an operator',
      insert('6a000000-0000-7000-8000-000000000003', 'api', null),
    ],
    ['a CLI change with an actor', insert('6a000000-0000-7000-8000-000000000004', 'cli', USER)],
    ['an unknown source', insert('6a000000-0000-7000-8000-000000000005', 'web', USER)],
    [
      'an unknown action',
      insert('6a000000-0000-7000-8000-000000000006', 'api', USER, 'model_deleted'),
    ],
  ])('reject %s (CHECK)', async (_name, sql) => {
    expect(await fails(sql)).toBe('23514');
  });
});
