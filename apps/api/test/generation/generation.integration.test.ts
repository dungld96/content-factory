// Script/storyboard pipeline API (M3 design package §6, §7, §10) over the real application with
// real PostgreSQL and Redis. The worker's success step is played by `completeJob` (the worker
// itself is tested in apps/worker and end to end in Playwright).
import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockLlmProvider } from '@acf/ai-core/testing';
import {
  GENERATION_QUEUE,
  scriptJobInputSchema,
  storyboardJobInputSchema,
} from '@acf/content-domain';
import {
  briefValidationSchema,
  generateResponseSchema,
  generationJobDetailSchema,
  pageSchema,
  productionRunSchema,
  scriptVersionSchema,
  storyboardVersionDetailSchema,
  storyboardVersionSchema,
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
  createFixture,
  SAMPLE_SCRIPT,
  seedUsers,
  signInAll,
  type Fixture,
} from '../support/workspace.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const prefix = `acf-gen-${randomUUID().slice(0, 8)}`;

let api: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let ids: Record<string, string>;
let as: ReturnType<typeof actAs>;
let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  api = await startAuthApp(
    { REDIS_URL, QUEUE_PREFIX: prefix },
    { llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]) },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(GENERATION_QUEUE, { connection: redis, prefix });
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  redis.disconnect();
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

const SCENE = {
  sceneNumber: 1,
  durationSeconds: 30,
  shotType: 'wide',
  cameraAngle: 'eye level',
  cameraMovement: 'static',
  characterAction: '',
  characterVersionId: null,
  environmentVersionId: null,
  visualDescription: 'Desk',
  imagePrompt: 'A desk',
  videoPrompt: 'Push in',
  negativePrompt: '',
  voiceOverSegment: 'Hello',
  onScreenText: '',
  requiredReferenceAssetIds: [],
  acceptanceChecks: [],
};

/** What the worker does on success (apps/worker GenerationProcessor), condensed. */
async function completeJob(jobId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1 },
    });
    const max = await tx.scriptVersion.count({ where: { contentItemId: job.contentItemId } });
    let versionId: string;
    if (job.kind === 'script_generation') {
      versionId = (
        await tx.scriptVersion.create({
          data: {
            projectId: job.projectId,
            contentItemId: job.contentItemId,
            version: max + 1,
            source: 'generated',
            generationJobId: job.id,
            schemaVersion: 1,
            content: SAMPLE_SCRIPT,
          },
        })
      ).id;
    } else {
      const sbs = await tx.storyboardVersion.count({ where: { contentItemId: job.contentItemId } });
      const input = job.input as { scriptVersionId: string };
      const sb = await tx.storyboardVersion.create({
        data: {
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          scriptVersionId: input.scriptVersionId,
          version: sbs + 1,
          source: 'generated',
          generationJobId: job.id,
          schemaVersion: 1,
          totalDurationSeconds: '30.00',
        },
      });
      // Reference assets are stored as scene asset rows, not a scene column.
      const scene: Omit<typeof SCENE, 'requiredReferenceAssetIds'> &
        Partial<Pick<typeof SCENE, 'requiredReferenceAssetIds'>> = { ...SCENE };
      delete scene.requiredReferenceAssetIds;
      await tx.storyboardScene.create({
        data: {
          ...scene,
          durationSeconds: '30.00',
          projectId: job.projectId,
          storyboardVersionId: sb.id,
        },
      });
      versionId = sb.id;
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: {
        status: 'succeeded',
        activeKey: null,
        completedAt: new Date(),
        ...(job.kind === 'script_generation'
          ? { resultScriptVersionId: versionId }
          : { resultStoryboardVersionId: versionId }),
      },
    });
    await tx.contentItem.update({
      where: { id: job.contentItemId },
      data: { status: job.kind === 'script_generation' ? 'script_review' : 'storyboard_review' },
    });
    return versionId;
  });
}

const status = async (f: Fixture) =>
  (await prisma.contentItem.findUniqueOrThrow({ where: { id: f.contentId } })).status;
const generate = async (f: Fixture, body: unknown = {}, headers: Record<string, string> = {}) =>
  as('editor', 'POST', `/content/${f.contentId}/scripts/generate`, { body, headers });

describe('brief validation', () => {
  it('returns warnings and claim flags without calling a model', async () => {
    const f = await createFixture(db, ids);
    await db.query(
      `UPDATE content_items SET brief = '{"topic":"Giá rẻ nhất cho máy lọc"}' WHERE id = '${f.contentId}'`,
    );
    const res = await as('viewer', 'POST', `/content/${f.contentId}/brief/validate`);
    expect(res.status).toBe(200);
    const body = briefValidationSchema.parse(res.json);
    expect(body.valid).toBe(true);
    expect(body.flags).toEqual(expect.arrayContaining(['giá', 'rẻ nhất']));
    expect(body.warnings.map((w) => w.path)).toContain('brief.sourceUrls');
  });

  it('blocks generation on brief errors and moves the item to needs_input', async () => {
    const f = await createFixture(db, ids);
    await db.query(
      `UPDATE content_items SET target_duration_seconds = 300 WHERE id = '${f.contentId}'`,
    );
    const res = await generate(f);
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({
      error: { code: 'BRIEF_INVALID', details: [{ path: 'targetDurationSeconds' }] },
    });
    expect(await status(f)).toBe('needs_input');
  });

  it('a character without an approved master is a brief error', async () => {
    const f = await createFixture(db, ids);
    await db.query(
      `UPDATE content_items SET brief = '{"topic":"x","characterId":"${f.characterId}"}' WHERE id = '${f.contentId}'`,
    );
    const body = briefValidationSchema.parse(
      (await as('viewer', 'POST', `/content/${f.contentId}/brief/validate`)).json,
    );
    expect(body.errors.map((e) => e.path)).toEqual(['brief.characterId']);
  });
});

describe('script generation', () => {
  it('persists intent, enqueues the job id and moves the item to scripting', async () => {
    const f = await createFixture(db, ids);
    const res = await generate(f);
    expect(res.status).toBe(202);
    const body = generateResponseSchema.parse(res.json);
    expect(body).toMatchObject({
      reused: false,
      job: { status: 'queued', kind: 'script_generation', modelKey: 'mock/echo', attempt: 0 },
    });
    expect(body.job.cost).toEqual({
      calls: 0,
      reportedUsd: '0',
      estimatedUsd: '0',
      unknownCalls: 0,
    });
    expect(await status(f)).toBe('scripting');
    const bull = await queue.getJob(body.job.id);
    expect(bull?.data).toEqual({ jobId: body.job.id }); // only the id travels through Redis
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: body.job.id },
      include: { events: true },
    });
    expect(job.previousContentStatus).toBe('draft');
    expect(job.events.map((e) => (e.detail as { type: string }).type)).toEqual(['created']);
    expect(job.input).toMatchObject({
      brief: { topic: 'Desk gadgets' },
      targetDurationSeconds: 30,
      aspectRatio: '9:16',
    });
    // The worker parses the stored input strictly: it must match the worker's schema exactly.
    expect(scriptJobInputSchema.safeParse(job.input).success).toBe(true);
  });

  it('refuses a second active job of the same kind', async () => {
    const f = await createFixture(db, ids);
    expect((await generate(f)).status).toBe(202);
    const again = await generate(f, { regenerate: true });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: { code: 'GENERATION_IN_PROGRESS' } });
  });

  it('dedupes a retried request with the same Idempotency-Key', async () => {
    const f = await createFixture(db, ids);
    const key = { 'idempotency-key': `retry-${randomUUID()}` };
    const first = generateResponseSchema.parse((await generate(f, {}, key)).json);
    const second = await generate(f, {}, key);
    expect(second.status).toBe(202);
    expect(generateResponseSchema.parse(second.json).job.id).toBe(first.job.id);
    expect(await prisma.generationJob.count({ where: { contentItemId: f.contentId } })).toBe(1);
    expect((await generate(f, {}, { 'idempotency-key': 'bad key!' })).status).toBe(400);
  });

  it('reuses an identical earlier result unless regenerate is set (no new cost)', async () => {
    const f = await createFixture(db, ids);
    const first = generateResponseSchema.parse((await generate(f)).json);
    await completeJob(first.job.id);
    const reused = generateResponseSchema.parse((await generate(f)).json);
    expect(reused).toMatchObject({ reused: true, job: { id: first.job.id, status: 'succeeded' } });
    const fresh = generateResponseSchema.parse((await generate(f, { regenerate: true })).json);
    expect(fresh.reused).toBe(false);
    expect(fresh.job.id).not.toBe(first.job.id);
  });

  it.each([
    [
      'no route',
      async () => db.query(`DELETE FROM ai_task_routes WHERE task = 'script_generation'`),
    ],
    [
      'a disabled routed model',
      async () =>
        db.query(`UPDATE ai_models SET status = 'disabled' WHERE model_key = 'mock/echo'`),
    ],
  ])('answers 422 NO_MODEL_ROUTE for %s', async (_name, setup) => {
    const f = await createFixture(db, ids);
    await setup();
    try {
      const res = await generate(f);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ error: { code: 'NO_MODEL_ROUTE' } });
      expect(await status(f)).toBe('draft');
    } finally {
      await seedAiRegistry(prisma, { openrouterConfigured: false });
      await db.query(`UPDATE ai_models SET status = 'enabled' WHERE model_key = 'mock/echo'`);
    }
  });

  it('refuses an override to a model without strict structured output support', async () => {
    const f = await createFixture(db, ids);
    const res = await generate(f, { modelKey: 'anthropic/claude-haiku-5.5' }); // disabled, unconfigured
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: { code: 'NO_MODEL_ROUTE' } });
  });

  it('exposes job status, events and cost', async () => {
    const f = await createFixture(db, ids);
    const created = generateResponseSchema.parse((await generate(f)).json);
    await completeJob(created.job.id);
    const res = await as('viewer', 'GET', `/generation-jobs/${created.job.id}`);
    expect(res.status).toBe(200);
    const job = generationJobDetailSchema.parse(res.json);
    expect(job).toMatchObject({
      status: 'succeeded',
      events: [{ type: 'created', toStatus: 'queued' }],
    });
    const run = productionRunSchema.parse(
      (await as('viewer', 'GET', `/production-runs/${created.productionRunId}`)).json,
    );
    expect(run.jobs.map((j) => j.id)).toEqual([created.job.id]);
  });
});

describe('versions, review and gates', () => {
  async function scriptedFixture() {
    const f = await createFixture(db, ids);
    const created = generateResponseSchema.parse((await generate(f)).json);
    const scriptId = await completeJob(created.job.id);
    return { f, scriptId };
  }

  it('an edit creates a new version and leaves the original untouched', async () => {
    const { f, scriptId } = await scriptedFixture();
    const res = await as('editor', 'PATCH', `/scripts/${scriptId}`, {
      body: { content: { ...SAMPLE_SCRIPT, hook: 'Sharper.' } },
    });
    expect(res.status).toBe(201);
    const edited = scriptVersionSchema.parse(res.json);
    expect(edited).toMatchObject({
      version: 2,
      source: 'edited',
      basedOnVersionId: scriptId,
      status: 'pending_review',
    });
    const original = scriptVersionSchema.parse(
      (await as('viewer', 'GET', `/scripts/${scriptId}`)).json,
    );
    expect(original.content.hook).toBe(SAMPLE_SCRIPT.hook);
    const list = pageSchema(scriptVersionSchema).parse(
      (await as('viewer', 'GET', `/content/${f.contentId}/scripts`)).json,
    );
    expect(list.data.map((v) => v.version)).toEqual([2, 1]);
  });

  it.each([
    ['a schema violation', { content: { ...SAMPLE_SCRIPT, hook: '' } }, 400],
    [
      'a source not in the brief',
      { content: { ...SAMPLE_SCRIPT, sources: [{ url: 'https://invented.test', usedFor: 'x' }] } },
      422,
    ],
  ])('rejects an edit with %s', async (_name, body, code) => {
    const { scriptId } = await scriptedFixture();
    expect((await as('editor', 'PATCH', `/scripts/${scriptId}`, { body })).status).toBe(code);
  });

  it('approves once; a reviewed version cannot be reviewed again', async () => {
    const { f, scriptId } = await scriptedFixture();
    const res = await as('editor', 'POST', `/scripts/${scriptId}/approve`);
    expect(res.status).toBe(200);
    expect(scriptVersionSchema.parse(res.json)).toMatchObject({
      status: 'approved',
      isApproved: true,
    });
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: f.contentId } }))
        .approvedScriptVersionId,
    ).toBe(scriptId);
    for (const action of ['approve', 'reject']) {
      const again = await as('editor', 'POST', `/scripts/${scriptId}/${action}`, { body: {} });
      expect(again.status).toBe(409);
      expect(again.json).toMatchObject({ error: { code: 'ARTIFACT_IMMUTABLE' } });
    }
  });

  it('storyboards only from the approved script; a newer approved script makes them stale', async () => {
    const { f, scriptId } = await scriptedFixture();
    const early = await as('editor', 'POST', `/scripts/${scriptId}/storyboards/generate`, {
      body: {},
    });
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ error: { code: 'SCRIPT_NOT_APPROVED' } });

    await as('editor', 'POST', `/scripts/${scriptId}/approve`);
    const sbJob = generateResponseSchema.parse(
      (await as('editor', 'POST', `/scripts/${scriptId}/storyboards/generate`, { body: {} })).json,
    );
    expect(await status(f)).toBe('storyboarding');
    const sbInput = await prisma.generationJob.findUniqueOrThrow({ where: { id: sbJob.job.id } });
    expect(storyboardJobInputSchema.safeParse(sbInput.input).success).toBe(true);
    const sbId = await completeJob(sbJob.job.id);

    // Edit a scene: new storyboard version, durations re-validated.
    const sb = storyboardVersionDetailSchema.parse(
      (await as('viewer', 'GET', `/storyboards/${sbId}`)).json,
    );
    const sceneId = sb.scenes[0]?.id ?? '';
    expect(
      (await as('editor', 'PATCH', `/scenes/${sceneId}`, { body: { durationSeconds: 45 } })).status,
    ).toBe(422);
    const edited = await as('editor', 'PATCH', `/scenes/${sceneId}`, {
      body: { imagePrompt: 'Brighter desk' },
    });
    expect(edited.status).toBe(201);
    const v2 = storyboardVersionDetailSchema.parse(edited.json);
    expect(v2).toMatchObject({
      version: 2,
      basedOnVersionId: sbId,
      scenes: [{ imagePrompt: 'Brighter desk' }],
    });

    // Approve the storyboard (gate 2).
    expect((await as('editor', 'POST', `/storyboards/${sbId}/approve`)).status).toBe(200);
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: f.contentId } }))
        .approvedStoryboardVersionId,
    ).toBe(sbId);

    // A new approved script clears gate 2 and makes every storyboard of the old script stale.
    const s2 = scriptVersionSchema.parse(
      (await as('editor', 'PATCH', `/scripts/${scriptId}`, { body: { content: SAMPLE_SCRIPT } }))
        .json,
    );
    await as('editor', 'POST', `/scripts/${s2.id}/approve`);
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: f.contentId } });
    expect(item).toMatchObject({
      approvedScriptVersionId: s2.id,
      approvedStoryboardVersionId: null,
    });
    const list = pageSchema(storyboardVersionSchema).parse(
      (await as('viewer', 'GET', `/content/${f.contentId}/storyboards`)).json,
    );
    expect(list.data.every((v) => v.stale)).toBe(true);
    const staleApprove = await as('editor', 'POST', `/storyboards/${v2.id}/approve`);
    expect(staleApprove.status).toBe(409);
    expect(staleApprove.json).toMatchObject({ error: { code: 'STALE_STORYBOARD' } });
  });

  it('rejects with a note and keeps the version for history', async () => {
    const { scriptId } = await scriptedFixture();
    const res = await as('editor', 'POST', `/scripts/${scriptId}/reject`, {
      body: { note: 'Off-brand tone' },
    });
    expect(scriptVersionSchema.parse(res.json)).toMatchObject({
      status: 'rejected',
      reviewNote: 'Off-brand tone',
    });
  });
});

describe('cancel and Redis outages', () => {
  it('cancels queued work and restores the content status; nothing left to cancel is 409', async () => {
    const f = await createFixture(db, ids);
    const created = generateResponseSchema.parse((await generate(f)).json);
    const res = await as('editor', 'POST', `/production-runs/${created.productionRunId}/cancel`);
    expect(res.status).toBe(200);
    expect(productionRunSchema.parse(res.json)).toMatchObject({
      status: 'canceled',
      jobs: [{ status: 'canceled' }],
    });
    expect(await status(f)).toBe('draft');
    const again = await as('editor', 'POST', `/production-runs/${created.productionRunId}/cancel`);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: { code: 'NOT_CANCELABLE' } });
    // The item can be generated again right away.
    expect((await generate(f)).status).toBe(202);
  });

  it('accepts the job when Redis is unreachable: the intent is in PostgreSQL for the reconciler', async () => {
    const offline = await startAuthApp(
      { REDIS_URL: 'redis://127.0.0.1:1', QUEUE_PREFIX: prefix },
      { llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]) },
    );
    try {
      const asOffline = actAs(offline.baseUrl, await signInAll(offline.baseUrl, ids));
      const f = await createFixture(db, ids);
      const started = Date.now();
      const res = await asOffline('editor', 'POST', `/content/${f.contentId}/scripts/generate`, {
        body: {},
      });
      expect(res.status).toBe(202);
      expect(Date.now() - started).toBeLessThan(6_000);
      const job = generateResponseSchema.parse(res.json).job;
      expect((await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
        'queued',
      );
    } finally {
      await offline.close();
    }
  });
});
