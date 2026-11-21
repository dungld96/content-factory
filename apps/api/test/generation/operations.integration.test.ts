// Resume, operations summary, held reservations and the cost dashboard over HTTP (M7 design §6,
// §8, §9). The worker is not running: job outcomes and ledger rows are written as it writes them.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockLlmProvider } from '@acf/ai-core/testing';
import type {
  BudgetDto,
  GenerateResponseDto,
  OpsSummaryDto,
  ProjectCostsDto,
  ResumeRunResponseDto,
} from '@acf/contracts';
import type { PrismaClient } from '@acf/database';

import { seedAiRegistry } from '../../src/cli/seed-ai.js';
import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import {
  actAs,
  addGenerationFixture,
  createFixture,
  seedUsers,
  signInAll,
  type Fixture,
  type GenerationFixture,
} from '../support/workspace.js';

let db: pg.Client;
let prisma: PrismaClient;
let ids: Record<string, string>;
let api: AuthTestApp;
let as: ReturnType<typeof actAs>;

type World = Fixture & GenerationFixture;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
const bodyOf = <T>(res: { json: unknown }) => res.json as T;
const codeOf = (res: { json: unknown }) =>
  (res.json as { error?: { code?: string } } | null)?.error?.code;

async function world(): Promise<World> {
  const base = await createFixture(db, ids);
  return { ...base, ...(await addGenerationFixture(db, ids, base)) };
}

/** Queues a script job through the API and ends it as the worker would. */
async function failedScriptJob(
  w: World,
  errorCode = 'PROVIDER_UNAVAILABLE',
): Promise<GenerateResponseDto> {
  const res = await as('editor', 'POST', `/content/${w.contentId}/scripts/generate`, {
    body: { regenerate: true },
  });
  expect(res.status).toBe(202);
  const created = bodyOf<GenerateResponseDto>(res);
  await db.query(`BEGIN;
    UPDATE generation_jobs SET status = 'running', attempt = 1, started_at = now() WHERE id = '${created.job.id}';
    UPDATE generation_jobs SET status = 'failed', active_key = NULL, completed_at = now(),
      error_code = '${errorCode}', error_message = 'x' WHERE id = '${created.job.id}';
    UPDATE production_runs SET status = 'failed', completed_at = now() WHERE id = '${created.productionRunId}';
    UPDATE content_items SET status = 'script_review' WHERE id = '${w.contentId}';
    COMMIT;`);
  return created;
}

/** One finished call of `jobId` in the ledger. */
async function invocation(
  w: World,
  jobId: string | null,
  cost: { reported?: string; estimated?: string },
  status: 'succeeded' | 'failed' = 'succeeded',
): Promise<void> {
  const provider = await prisma.aiProvider.findUniqueOrThrow({ where: { key: 'mock' } });
  const model = await prisma.aiModel.findFirstOrThrow({
    where: { providerId: provider.id, modelKey: 'mock/echo' },
  });
  const row = await prisma.aiInvocation.create({
    data: {
      projectId: w.projectId,
      contentItemId: w.contentId,
      generationJobId: jobId,
      correlationId: randomUUID(),
      capability: 'llm',
      providerId: provider.id,
      modelId: model.id,
      requestSummary: {},
    },
  });
  await prisma.aiInvocation.update({
    where: { id: row.id },
    data: {
      status,
      completedAt: new Date(),
      ...(status === 'failed' ? { errorCode: 'PROVIDER_ERROR' } : {}),
      ...(cost.reported !== undefined
        ? { costStatus: 'reported', reportedCost: cost.reported }
        : cost.estimated !== undefined
          ? { costStatus: 'estimated', estimatedCost: cost.estimated }
          : { costStatus: 'unknown' }),
    },
  });
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  api = await startAuthApp(
    {
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      QUEUE_PREFIX: `acf-ops-${randomUUID().slice(0, 8)}`,
    },
    { llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]) },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('POST /production-runs/:runId/resume', () => {
  it('requests the failed stage again in a new run linked to the old one, once', async () => {
    const w = await world();
    const failed = await failedScriptJob(w);
    const runId = failed.productionRunId;
    expect(
      (await as('viewer', 'POST', `/production-runs/${runId}/resume`, { body: {} })).status,
    ).toBe(403);

    const res = await as('editor', 'POST', `/production-runs/${runId}/resume`, { body: {} });
    expect(res.status).toBe(202);
    const resumed = bodyOf<ResumeRunResponseDto>(res);
    expect(resumed).toMatchObject({ resumedFromRunId: runId, skipped: [] });
    expect(resumed.run).toMatchObject({ resumedFromRunId: runId, status: 'queued' });
    expect(resumed.run?.id).not.toBe(runId);
    expect(resumed.run?.jobs).toHaveLength(1);
    expect(resumed.run?.jobs[0]).toMatchObject({ kind: 'script_generation', status: 'queued' });
    // Resumed work is budgeted like any request.
    expect(
      await prisma.budgetReservation.count({ where: { jobId: resumed.run?.jobs[0]?.id ?? '' } }),
    ).toBe(1);

    // The new job is queued: resuming the old run again has nothing left to do.
    const again = await as('editor', 'POST', `/production-runs/${runId}/resume`, { body: {} });
    expect([again.status, codeOf(again)]).toEqual([409, 'NOTHING_TO_RESUME']);
    expect((again.json as { error: { current: unknown } }).error.current).toEqual({
      skipped: [{ jobId: failed.job.id, sceneId: null, reason: 'in_progress' }],
    });
  });

  it.each(['SUBMIT_OUTCOME_UNKNOWN', 'CALL_OUTCOME_UNKNOWN'])(
    'skips a possibly charged call (%s) unless a double charge is accepted',
    async (code) => {
      const w = await world();
      const failed = await failedScriptJob(w, code);
      const runId = failed.productionRunId;
      const refused = await as('editor', 'POST', `/production-runs/${runId}/resume`, { body: {} });
      expect([refused.status, codeOf(refused)]).toEqual([409, 'NOTHING_TO_RESUME']);
      expect((refused.json as { error: { current: unknown } }).error.current).toEqual({
        skipped: [{ jobId: failed.job.id, sceneId: null, reason: 'outcome_unknown' }],
      });
      const accepted = await as('editor', 'POST', `/production-runs/${runId}/resume`, {
        body: { acceptPossibleDoubleCharge: true },
      });
      expect(accepted.status).toBe(202);
    },
  );

  it('refuses a run without failures', async () => {
    const w = await world();
    const res = await as('editor', 'POST', `/production-runs/${w.runId}/resume`, { body: {} });
    expect([res.status, codeOf(res)]).toEqual([409, 'NOTHING_TO_RESUME']);
  });
});

// From here on the mock LLM costs USD 0.00005 per input token, so a script job reserves its
// worst case: 6 000 tokens × 2 calls = USD 0.6 (prices are append-only: these blocks come last).
describe('operations summary and held reservations', () => {
  beforeAll(async () => {
    const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'mock/echo' } });
    await prisma.aiModelPrice.create({
      data: {
        modelId: model.id,
        metric: 'input_tokens',
        unitPrice: '0.00005',
        sourceValue: '0.00005',
        effectiveFrom: new Date(Date.now() - 1000),
        source: 'manual_estimate',
        sourceUrl: 'urn:acf:test',
        capturedAt: new Date(),
      },
    });
  });

  it('shows failures, budgets and held reservations of your projects only; owners resolve them', async () => {
    const w = await world();
    const failed = await failedScriptJob(w, 'SUBMIT_OUTCOME_UNKNOWN');
    // The worker holds the reservation of a lost submission.
    await prisma.budgetReservation.update({
      where: { jobId: failed.job.id },
      data: { status: 'held' },
    });
    const reservation = await prisma.budgetReservation.findUniqueOrThrow({
      where: { jobId: failed.job.id },
    });

    const owner = bodyOf<OpsSummaryDto>(await as('owner', 'GET', '/ops/summary'));
    expect(owner.failedJobs.map((j) => j.jobId)).toContain(failed.job.id);
    expect(owner.budgets.find((b) => b.projectId === w.projectId)).toMatchObject({
      limitUsd: '10',
      heldUsd: '0.6',
    });
    expect(owner.heldReservations).toContainEqual(
      expect.objectContaining({
        id: reservation.id,
        canResolve: true,
        amountUsd: '0.6',
        jobErrorCode: 'SUBMIT_OUTCOME_UNKNOWN',
      }),
    );
    expect(owner.queues === null || owner.queues.some((q) => q.queue === 'generation')).toBe(true);

    const editor = bodyOf<OpsSummaryDto>(await as('editor', 'GET', '/ops/summary'));
    expect(editor.heldReservations.find((r) => r.id === reservation.id)?.canResolve).toBe(false);
    const outsider = bodyOf<OpsSummaryDto>(await as('outsider', 'GET', '/ops/summary'));
    expect(outsider.failedJobs.some((j) => j.projectId === w.projectId)).toBe(false);
    expect(outsider.heldReservations.some((r) => r.projectId === w.projectId)).toBe(false);

    const path = `/ops/reservations/${reservation.id}`;
    expect((await as('editor', 'POST', `${path}/settle`, { body: {} })).status).toBe(403);
    expect((await as('outsider', 'POST', `${path}/settle`, { body: {} })).status).toBe(404);
    const settled = await as('owner', 'POST', `${path}/settle`, {
      body: { note: 'charged on the invoice' },
    });
    expect(settled.status).toBe(200);
    const after = await prisma.budgetReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect([after.status, after.settledChargeUsd?.toString()]).toEqual(['settled', '0.6']);
    // The confirmed charge keeps counting as spent.
    expect(
      bodyOf<BudgetDto>(await as('viewer', 'GET', `/projects/${w.projectId}/budget`)),
    ).toMatchObject({
      spentUsd: '0.6',
      heldUsd: '0',
    });
    const again = await as('owner', 'POST', `${path}/release`, { body: {} });
    expect([again.status, codeOf(again)]).toEqual([409, 'RESERVATION_NOT_HELD']);
    const event = await prisma.budgetEvent.findFirstOrThrow({
      where: { projectId: w.projectId, type: 'settled' },
    });
    expect(event).toMatchObject({
      actorId: ids['owner'],
      detail: { reservationId: reservation.id, note: 'charged on the invoice' },
    });
  });
});

describe('GET /projects/:projectId/costs', () => {
  it('keeps reported, estimated, unknown and held apart, by item, stage and model, with retries and a trend', async () => {
    const w = await world();
    await invocation(w, w.jobId, { reported: '0.25' });
    await invocation(w, w.jobId, { estimated: '0.1' });
    await invocation(w, w.jobId, {}); // unknown: counted, never priced
    const failed = await failedScriptJob(w);
    await invocation(w, failed.job.id, { reported: '0.05' }, 'failed');
    const held = await failedScriptJob(w, 'SUBMIT_OUTCOME_UNKNOWN');
    await prisma.budgetReservation.update({
      where: { jobId: held.job.id },
      data: { status: 'held' },
    });

    const res = await as('viewer', 'GET', `/projects/${w.projectId}/costs`);
    expect(res.status).toBe(200);
    const costs = bodyOf<ProjectCostsDto>(res);
    expect(costs.total).toEqual({
      calls: 4,
      reportedUsd: '0.3',
      estimatedUsd: '0.1',
      unknownCalls: 1,
      heldUsd: '0.6',
      totalUsd: '1',
    });
    expect(costs.budget).toEqual({ limitUsd: '10', warning: false });
    expect(costs.byContentItem).toEqual([
      { contentItemId: w.contentId, title: expect.any(String), cost: costs.total },
    ]);
    expect(costs.byStage).toEqual([{ kind: 'script_generation', cost: costs.total }]);
    expect(costs.byModel).toEqual([
      { providerKey: 'mock', modelKey: 'mock/echo', cost: costs.total },
    ]);
    expect(costs.retryCost).toMatchObject({ calls: 1, reportedUsd: '0.05', totalUsd: '0.05' });
    expect(costs.costPerApprovedVideo).toBeNull();
    expect(costs.trend).toHaveLength(6);
    expect(costs.trend[5]).toEqual({ month: costs.month, cost: costs.total });
    expect(costs.trend[0]?.cost.totalUsd).toBe('0');

    const earlier = bodyOf<ProjectCostsDto>(
      await as('viewer', 'GET', `/projects/${w.projectId}/costs?month=2020-01`),
    );
    expect(earlier).toMatchObject({ month: '2020-01', total: { calls: 0, totalUsd: '0' } });
    expect((await as('viewer', 'GET', `/projects/${w.projectId}/costs?month=2020-13`)).status).toBe(
      400,
    );
    expect((await as('outsider', 'GET', `/projects/${w.projectId}/costs`)).status).toBe(404);
  });
});
