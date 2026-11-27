// Budgets over HTTP and in the reservation service (M7 design §3–§5): defaults, owner-only
// changes, hard and soft limits on a real generate request, the override event, and two
// concurrent reservations that cannot together exceed the monthly limit.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UsdAmount } from '@acf/ai-core';
import {
  MockImageProvider,
  MockLlmProvider,
  MockTtsProvider,
  MockVideoProvider,
} from '@acf/ai-core/testing';
import type { BudgetDto, ImageGenerateResponseDto, VideoEstimateDto } from '@acf/contracts';
import { storageSettings } from '@acf/config';
import type { PrismaClient } from '@acf/database';
import { assetObjectKey, S3ObjectStore, sha256Hex, type ObjectStore } from '@acf/storage';
import { solidPng } from '@acf/storage/testing';

import { BudgetsService } from '../../src/budgets/budgets.service.js';
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
let store: ObjectStore;

type World = Fixture & GenerationFixture;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
const bodyOf = <T>(res: { json: unknown }) => res.json as T;
const codeOf = (res: { json: unknown }) =>
  (res.json as { error?: { code?: string } } | null)?.error?.code;
const currentOf = (res: { json: unknown }) =>
  (res.json as { error?: { current?: unknown } } | null)?.error?.current;

async function world(): Promise<World> {
  const base = await createFixture(db, ids);
  return { ...base, ...(await addGenerationFixture(db, ids, base)) };
}

/** A storyboard approved, with an approved keyframe selected for its one 30 s scene. */
async function clipReadyWorld(): Promise<World> {
  const w = await world();
  await db.query(
    `UPDATE content_items SET status = 'storyboard_review' WHERE id = '${w.contentId}'`,
  );
  expect((await as('editor', 'POST', `/storyboards/${w.storyboardId}/approve`)).status).toBe(200);
  const job = bodyOf<ImageGenerateResponseDto>(
    await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
  ).jobs[0];
  const assetId = randomUUID();
  const bytes = solidPng(9, 16, 3);
  const checksum = sha256Hex(bytes);
  const storageKey = assetObjectKey({
    projectId: w.projectId,
    assetId,
    sha256Hex: checksum,
    mimeType: 'image/png',
  });
  await store.putIfAbsent(storageKey, bytes, { contentType: 'image/png', sha256Hex: checksum });
  await db.query(`BEGIN;
    UPDATE generation_jobs SET status = 'running', attempt = 1, started_at = now() WHERE id = '${job?.id ?? ''}';
    INSERT INTO assets (id, project_id, content_item_id, asset_type, source_type, generation_job_id,
        storyboard_scene_id, storage_key, mime_type, size_bytes, checksum_sha256, width, height,
        created_by_id, updated_at)
      VALUES ('${assetId}', '${w.projectId}', '${w.contentId}', 'image', 'generated', '${job?.id ?? ''}',
        '${w.sceneId}', '${storageKey}', 'image/png', ${String(bytes.byteLength)}, '${checksum}',
        360, 640, '${ids['editor'] ?? ''}', now());
    UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now() WHERE id = '${job?.id ?? ''}';
    UPDATE content_items SET status = 'asset_review' WHERE id = '${w.contentId}';
    COMMIT;`);
  expect((await as('editor', 'POST', `/assets/${assetId}/approve`)).status).toBe(200);
  expect(
    (await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId } })).status,
  ).toBe(200);
  return w;
}

/** A queued job of the world's content item (reservation target for service-level tests). */
async function queuedJob(w: World, kind: 'render' | 'storyboard_generation'): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind,
      status, attempt, active_key, idempotency_key, execution_key, input, previous_content_status,
      prompt_template_id, model_id, requested_by_id, updated_at)
    SELECT '${id}', '${w.projectId}', '${w.contentId}', '${w.runId}', '${kind}', 'queued', 0,
      '${w.contentId}:${kind}', 'b-${id}', repeat('e', 64), '{}', 'draft', 'x.v1', m.id, '${ids['owner'] ?? ''}', now()
    FROM ai_models m WHERE m.model_key = 'mock/echo'`);
  return id;
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
      QUEUE_PREFIX: `acf-budget-${randomUUID().slice(0, 8)}`,
    },
    {
      llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]),
      imageProviders: new Map([['mock', new MockImageProvider({ providerKey: 'mock' })]]),
      videoProviders: new Map([['mock', new MockVideoProvider({ providerKey: 'mock' })]]),
      ttsProviders: new Map([['mock', new MockTtsProvider({ providerKey: 'mock' })]]),
    },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
  const settings = storageSettings(api.env);
  if (!settings) throw new Error('budget API tests need object storage (S3_* variables)');
  store = new S3ObjectStore(settings);
  // Clips of the mock video model cost USD 0.50 per second: the 30 s fixture scene costs USD 15.
  const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'mock/still-video' } });
  await prisma.aiModel.update({
    where: { id: model.id },
    data: {
      mediaConstraints: {
        kind: 'video',
        durations: [5, 10, 30],
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['9:16', '1:1', '16:9'],
        frameImages: ['first_frame'],
        audio: false,
        seed: true,
      },
    },
  });
  await prisma.aiModelPrice.create({
    data: {
      modelId: model.id,
      metric: 'output_video_seconds',
      unitPrice: '0.5',
      sourceValue: '0.5',
      effectiveFrom: new Date(Date.now() - 1000),
      source: 'manual_estimate',
      sourceUrl: 'urn:acf:test',
      capturedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('GET/PUT /projects/:projectId/budget', () => {
  it('shows the defaults to members and lets only the owner change them', async () => {
    const f = await createFixture(db, ids);
    const res = await as('viewer', 'GET', `/projects/${f.projectId}/budget`);
    expect(res.status).toBe(200);
    expect(bodyOf<BudgetDto>(res)).toMatchObject({
      projectId: f.projectId,
      monthly: { limitUsd: '10', mode: 'hard' },
      item: { limitUsd: '3', mode: 'soft' },
      request: { limitUsd: '2', mode: 'hard' },
      spentUsd: '0',
      reservedUsd: '0',
      heldUsd: '0',
      unknownCalls: 0,
      remainingUsd: '10',
      warning: false,
    });
    expect((await as('outsider', 'GET', `/projects/${f.projectId}/budget`)).status).toBe(404);

    const change = {
      monthly: { limitUsd: '25', mode: 'soft' },
      request: { limitUsd: null, mode: 'hard' },
    };
    expect(
      (await as('editor', 'PUT', `/projects/${f.projectId}/budget`, { body: change })).status,
    ).toBe(403);
    expect((await as('owner', 'PUT', `/projects/${f.projectId}/budget`, { body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await as('owner', 'PUT', `/projects/${f.projectId}/budget`, {
          body: { monthly: { limitUsd: '-1', mode: 'hard' } },
        })
      ).status,
    ).toBe(400);
    const updated = await as('owner', 'PUT', `/projects/${f.projectId}/budget`, { body: change });
    expect(updated.status).toBe(200);
    expect(bodyOf<BudgetDto>(updated)).toMatchObject({
      monthly: { limitUsd: '25', mode: 'soft' },
      item: { limitUsd: '3', mode: 'soft' },
      request: { limitUsd: null, mode: 'hard' },
      remainingUsd: '25',
    });
    const events = await prisma.budgetEvent.findMany({ where: { projectId: f.projectId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'changed', actorId: ids['owner'] });
  });
});

describe('enforcement on generate requests', () => {
  it('blocks a hard limit, asks to confirm a soft one, and reserves what it queues', async () => {
    const w = await clipReadyWorld();
    const estimate = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(estimate).toMatchObject({ totalEstimatedUsd: '15', requestBudgetUsd: '2' });
    const generate = (extra: Record<string, unknown> = {}) =>
      as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
        body: { confirmedEstimateUsd: '15', ...extra },
      });

    // Per request: USD 2, hard.
    const blocked = await generate();
    expect([blocked.status, codeOf(blocked)]).toEqual([402, 'BUDGET_EXCEEDED']);
    expect(currentOf(blocked)).toEqual({
      scope: 'request',
      mode: 'hard',
      limitUsd: '2',
      spentUsd: '0',
      requestedUsd: '15',
    });
    // Accepting does not override a hard limit.
    expect(codeOf(await generate({ acceptOverBudget: true }))).toBe('BUDGET_EXCEEDED');

    // No request limit; monthly USD 10 hard still blocks before the soft item limit is asked.
    const owner = (body: unknown) =>
      as('owner', 'PUT', `/projects/${w.projectId}/budget`, { body });
    expect((await owner({ request: { limitUsd: null, mode: 'hard' } })).status).toBe(200);
    const monthly = await generate({ acceptOverBudget: true });
    expect([monthly.status, codeOf(monthly)]).toEqual([402, 'BUDGET_EXCEEDED']);
    expect(currentOf(monthly)).toMatchObject({ scope: 'month', limitUsd: '10' });

    // Monthly USD 100: the item limit (USD 3, soft) needs confirmation.
    expect((await owner({ monthly: { limitUsd: '100', mode: 'hard' } })).status).toBe(200);
    const soft = await generate();
    expect([soft.status, codeOf(soft)]).toEqual([409, 'BUDGET_CONFIRMATION_REQUIRED']);
    expect(currentOf(soft)).toMatchObject({ scope: 'item', mode: 'soft', limitUsd: '3' });
    expect(
      await prisma.generationJob.count({
        where: { kind: 'video_generation', contentItemId: w.contentId },
      }),
    ).toBe(0);

    const accepted = await generate({ acceptOverBudget: true });
    expect(accepted.status).toBe(202);
    const job = await prisma.generationJob.findFirstOrThrow({
      where: { kind: 'video_generation', contentItemId: w.contentId },
      include: { reservation: true },
    });
    expect(job.reservation).toMatchObject({ kind: 'estimate', status: 'open' });
    expect(job.reservation?.amountUsd.toString()).toBe('15');
    const override = await prisma.budgetEvent.findFirstOrThrow({
      where: { projectId: w.projectId, type: 'override' },
    });
    expect(override).toMatchObject({
      actorId: ids['editor'],
      detail: { scope: 'item', requestedUsd: '15' },
    });

    const budget = bodyOf<BudgetDto>(await as('viewer', 'GET', `/projects/${w.projectId}/budget`));
    expect(budget).toMatchObject({ reservedUsd: '15', remainingUsd: '85' });

    // Canceled before the provider call: nothing will be charged, the reservation is released.
    expect(
      (await as('editor', 'POST', `/production-runs/${job.productionRunId}/cancel`)).status,
    ).toBe(200);
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({ where: { jobId: job.id } }),
    ).toMatchObject({
      status: 'released',
    });
    expect(
      bodyOf<BudgetDto>(await as('viewer', 'GET', `/projects/${w.projectId}/budget`)),
    ).toMatchObject({
      reservedUsd: '0',
      remainingUsd: '100',
    });
  });
});

describe('BudgetsService.reserve', () => {
  it('reserves the placeholder per call for an unknown cost', async () => {
    const w = await world();
    const jobId = await queuedJob(w, 'render');
    const budgets = api.app.get(BudgetsService);
    await prisma.$transaction((tx) =>
      budgets.reserve(tx, {
        actorId: ids['owner'] ?? '',
        projectId: w.projectId,
        contentItemId: w.contentId,
        jobs: [{ jobId, estimate: null, calls: 2 }],
      }),
    );
    const r = await prisma.budgetReservation.findUniqueOrThrow({ where: { jobId } });
    expect([r.kind, r.amountUsd.toString(), r.status]).toEqual([
      'unknown_placeholder',
      '1',
      'open',
    ]);
  });

  it('serialises concurrent reservations: together they never exceed the monthly limit', async () => {
    const w = await world();
    const owner = (body: unknown) =>
      as('owner', 'PUT', `/projects/${w.projectId}/budget`, { body });
    expect(
      (
        await owner({
          monthly: { limitUsd: '1', mode: 'hard' },
          item: { limitUsd: null, mode: 'soft' },
        })
      ).status,
    ).toBe(200);
    const jobs = [await queuedJob(w, 'render'), await queuedJob(w, 'storyboard_generation')];
    const budgets = api.app.get(BudgetsService);
    const results = await Promise.allSettled(
      jobs.map((jobId) =>
        prisma.$transaction(async (tx) => {
          await budgets.reserve(tx, {
            actorId: ids['owner'] ?? '',
            projectId: w.projectId,
            contentItemId: w.contentId,
            jobs: [{ jobId, estimate: UsdAmount.parse('0.6') }],
          });
          // Hold the lock long enough for the other request to wait on it.
          await tx.$executeRaw`SELECT pg_sleep(0.2)`;
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ response: { code: 'BUDGET_EXCEEDED' } });
    expect(await prisma.budgetReservation.count({ where: { projectId: w.projectId } })).toBe(1);
  });
});
