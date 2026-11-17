// Deterministic concurrency matrix (ADR-0010, ADR-0011 §5–6; design package §6.3.1).
// Every scenario asserts both sessions' exact outcome (commit / SQLSTATE / service decision),
// that no session deadlocked (a 40P01 on a protocol-following path is a defect), that the
// schedule really overlapped on a lock, and that the invariants hold afterwards.
// Sessions connect as the runtime role acf_app.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  invariants,
  type Isolation,
  type RefMode,
  scenarios,
  seed,
} from './support/concurrency-scenarios.js';
import { connect, truncateAll } from './support/db.js';
import { runSchedule } from './support/lock-matrix.js';

let migrator: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

const ISOLATIONS: readonly Isolation[] = ['READ COMMITTED', 'REPEATABLE READ'];
const REFS: readonly RefMode[] = ['primary', 'link'];

describe.each(ISOLATIONS)('%s', (iso) => {
  describe.each(REFS)('%s asset reference', (ref) => {
    it.each(scenarios(iso, ref).map((sc) => [sc.id, sc] as const))('%s', async (_id, sc) => {
      await truncateAll(migrator);
      await seed(app, ref);

      const result = await runSchedule(migrator, inject('databaseUrls').appUrl, sc.steps);
      const context = `${sc.id} (${sc.what})\ntrace: ${result.trace.join(' | ')}`;

      expect([result.A, result.B], context).not.toContain('40P01');
      expect({ A: result.A, B: result.B }, context).toEqual(sc.expect);
      if (sc.overlapOptional !== true) {
        expect(result.blockedSteps.length, `schedule never blocked: ${context}`).toBeGreaterThan(0);
      }
      expect(await invariants(migrator), context).toEqual({
        approvedWithArchivedAsset: 0,
        projectsWithoutOwner: 0,
        masterNotHighestApproved: 0,
        approvedLinksAddedAfterApproval: 0,
      });
      if (sc.check) expect(await sc.check(migrator), context).toBeNull();
    });
  });
});
