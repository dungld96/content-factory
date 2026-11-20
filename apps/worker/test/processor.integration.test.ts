// GenerationProcessor against real PostgreSQL with a scripted mock LLM (M3 design §7.4, §8).
// No Redis here: the BullMQ wiring is covered by queue.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  type LlmProvider,
} from '@acf/ai-core';
import { MockLlmProvider } from '@acf/ai-core/testing';
import { LlmService, ModelCatalog } from '@acf/ai-runtime';
import type { DeadLetterPayload } from '@acf/content-domain';
import { sampleScene, sampleScript, sampleStoryboard } from '@acf/content-domain/testing';
import type { PrismaClient } from '@acf/database';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { silentLogger } from '../src/logger.js';
import {
  appPrisma,
  approveScript,
  createJob,
  createWorld,
  migratorPrisma,
  reset,
  scriptInput,
  storyboardInput,
  type World,
} from './support/fixtures.js';

let prisma: PrismaClient;
let migrator: PrismaClient;
let world: World;
let mock: MockLlmProvider;
let deadLetters: DeadLetterPayload[];
let processor: GenerationProcessor;

const json = (value: unknown) => JSON.stringify(value);
const providerError = (
  code: keyof typeof ProviderErrorCode,
  outcome: ProviderErrorOutcome,
  retryAfterMs?: number,
) =>
  new ProviderError(ProviderErrorCode[code], code.toLowerCase(), {
    outcome,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

function build(
  providers: ReadonlyMap<string, LlmProvider> = new Map([['mock', mock]]),
): GenerationProcessor {
  const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: 120_000,
  });
  return new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm,
    deadLetter: (p) => {
      deadLetters.push(p);
      return Promise.resolve();
    },
    logger: silentLogger,
    random: () => 0.5,
  });
}

const jobRow = (id: string) =>
  prisma.generationJob.findUniqueOrThrow({
    where: { id },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
const contentStatus = async () =>
  (await prisma.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } })).status;

beforeAll(() => {
  prisma = appPrisma();
  migrator = migratorPrisma();
});

afterAll(async () => {
  await prisma.$disconnect();
  await migrator.$disconnect();
});

beforeEach(async () => {
  await reset(migrator);
  world = await createWorld(prisma);
  mock = new MockLlmProvider({ providerKey: 'mock' });
  deadLetters = [];
  processor = build();
});

describe('script generation', () => {
  it('generates a schema-valid script version, links cost to the job, moves the content to review', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({
      kind: 'result',
      text: json(sampleScript()),
      usage: { inputTokens: 900, outputTokens: 400 },
    });

    const outcome = await processor.process(jobId);
    expect(outcome.type).toBe('succeeded');

    const job = await jobRow(jobId);
    expect(job).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      activeKey: null,
      errorCode: null,
    });
    expect(job.promptSnapshot).toContain('### system');
    expect(job.promptSnapshot).toContain('Khánh'); // character master in the prompt
    expect(job.events.map((e) => (e.detail as { type: string }).type)).toEqual([
      'created',
      'attempt_started',
      'succeeded',
    ]);

    const version = await prisma.scriptVersion.findUniqueOrThrow({
      where: { id: job.resultScriptVersionId ?? '' },
    });
    expect(version).toMatchObject({
      version: 1,
      status: 'pending_review',
      source: 'generated',
      generationJobId: jobId,
      schemaVersion: 1,
    });
    expect((version.content as { title: string }).title).toBe(sampleScript().title);

    const invocations = await prisma.aiInvocation.findMany({ where: { generationJobId: jobId } });
    expect(invocations.map((i) => [i.status, i.idempotencyKey])).toEqual([
      ['succeeded', `${jobId}:1:1`],
    ]);
    expect(await contentStatus()).toBe('script_review');
    expect(
      (await prisma.productionRun.findUniqueOrThrow({ where: { id: job.productionRunId } })).status,
    ).toBe('succeeded');

    // The request asked for strict structured output generated from the same schema.
    const sent = mock.calls[0]?.request;
    expect(sent?.responseFormat).toMatchObject({
      type: 'json_schema',
      name: 'script_content',
      strict: true,
    });
    expect(sent?.maxOutputTokens).toBe(4000);
  });

  it('repairs a code-fenced answer deterministically (no extra call)', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'result', text: `Sure!\n\`\`\`json\n${json(sampleScript())}\n\`\`\`` });
    expect((await processor.process(jobId)).type).toBe('succeeded');
    expect(mock.calls).toHaveLength(1);
  });

  it('makes exactly one repair call for schema-invalid output, and succeeds with it', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue(
      { kind: 'result', text: json({ ...sampleScript(), hook: '' }) },
      { kind: 'result', text: json(sampleScript()) },
    );
    expect((await processor.process(jobId)).type).toBe('succeeded');
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.request.messages[1]?.content).toContain('hook');
    const keys = (
      await prisma.aiInvocation.findMany({
        where: { generationJobId: jobId },
        orderBy: { startedAt: 'asc' },
      })
    ).map((i) => i.idempotencyKey);
    expect(keys).toEqual([`${jobId}:1:1`, `${jobId}:1:2`]);
  });

  it('rejects output still invalid after the repair: OUTPUT_INVALID, nothing persisted, DLQ copy, content restored', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue(
      { kind: 'result', text: 'not json at all' },
      { kind: 'result', text: json({ title: 'x' }) },
    );
    expect(await processor.process(jobId)).toEqual({ type: 'failed', errorCode: 'OUTPUT_INVALID' });
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'failed', errorCode: 'OUTPUT_INVALID', activeKey: null });
    const failed = job.events.at(-1)?.detail as { issues: string[] };
    expect(failed.issues.length).toBeGreaterThan(0);
    expect(failed.issues.every((i) => i.endsWith(': invalid'))).toBe(true); // paths only, no content
    expect(await prisma.scriptVersion.count()).toBe(0);
    expect(deadLetters.map((d) => [d.jobId, d.errorCode])).toEqual([[jobId, 'OUTPUT_INVALID']]);
    expect(await contentStatus()).toBe('draft');
    expect(mock.calls).toHaveLength(2); // never a second repair (Q5)
  });

  it('keeps the DB failure when the dead-letter copy cannot be written', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    const providers = new Map([['mock', mock]]);
    const failing = new GenerationProcessor({
      prisma,
      jobs: new JobStore(prisma),
      llm: new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
        providerTimeoutMs: 120_000,
      }),
      deadLetter: () => Promise.reject(new Error('redis down')),
      logger: silentLogger,
    });
    mock.enqueue({
      kind: 'error',
      error: providerError('AUTHENTICATION', ProviderErrorOutcome.REJECTED),
    });
    expect(await failing.process(jobId)).toEqual({ type: 'failed', errorCode: 'AUTHENTICATION' });
    expect((await jobRow(jobId)).status).toBe('failed');
  });

  it('rejects sources that are not in the brief (anti-fabrication)', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    const fabricated = json(
      sampleScript({ sources: [{ url: 'https://invented.test/stats', usedFor: 'statistic' }] }),
    );
    mock.enqueue({ kind: 'result', text: fabricated }, { kind: 'result', text: fabricated });
    expect((await processor.process(jobId)).type).toBe('failed');
  });
});

describe('storyboard generation', () => {
  async function approvedScript(): Promise<string> {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'result', text: json(sampleScript()) });
    await processor.process(jobId);
    const id = (await jobRow(jobId)).resultScriptVersionId ?? '';
    await approveScript(prisma, world, id);
    return id;
  }

  it('storyboard.v2: scenes must use the clip lengths; a basic-schema model gets the structure only (M8.5)', async () => {
    const scriptId = await approvedScript();
    await prisma.aiModel.update({ where: { id: world.modelId }, data: { schemaMode: 'basic' } });
    const jobId = await createJob(
      prisma,
      world,
      'storyboard_generation',
      { ...storyboardInput(world, scriptId), clipDurations: [4, 6, 8], wordsPerSecond: 2.7 },
      'storyboard.v2',
    );
    // First answer: 5 + 10 + 7 + 8 = 30 s, but 5, 10 and 7 are not clip lengths → one repair.
    const off = sampleStoryboard(4, 6);
    [5, 10, 7, 8].forEach((d, i) => {
      const scene = off.scenes[i];
      if (scene) scene.durationSeconds = d;
    });
    mock.enqueue({ kind: 'result', text: json(off) });
    const fixed = sampleStoryboard(4, 6);
    [6, 8, 8, 8].forEach((d, i) => {
      const scene = fixed.scenes[i];
      if (scene) scene.durationSeconds = d;
    });
    mock.enqueue({ kind: 'result', text: json(fixed) });

    const before = mock.calls.length;
    expect((await processor.process(jobId)).type).toBe('succeeded');
    const [first, repair] = mock.calls.slice(before);
    const system = first?.request.messages[0]?.content ?? '';
    expect(system).toContain('exactly one of: 4, 6, 8');
    expect(system).toContain('2.7 words per second');
    // The provider got no value constraints; the repair prompt names the broken lengths.
    expect(JSON.stringify(first?.request.responseFormat)).not.toContain('maxLength');
    expect(repair?.request.messages.map((m) => m.content).join('\n')).toContain(
      '5 s is not a clip length',
    );
    const job = await jobRow(jobId);
    const scenes = await prisma.storyboardScene.findMany({
      where: { storyboardVersionId: job.resultStoryboardVersionId ?? '' },
      orderBy: { sceneNumber: 'asc' },
    });
    expect(scenes.map((sc) => Number(sc.durationSeconds))).toEqual([6, 8, 8, 8]);
  });

  it('stores scenes with offered character/environment versions and reference assets', async () => {
    const scriptId = await approvedScript();
    const jobId = await createJob(
      prisma,
      world,
      'storyboard_generation',
      storyboardInput(world, scriptId),
    );
    const sb = sampleStoryboard();
    sb.scenes[0] = sampleScene(1, {
      characterVersionId: world.characterVersionId,
      environmentVersionId: world.environmentVersionId,
      requiredReferenceAssetIds: [world.assetId],
    });
    mock.enqueue({ kind: 'result', text: json(sb) });
    expect((await processor.process(jobId)).type).toBe('succeeded');

    const job = await jobRow(jobId);
    const version = await prisma.storyboardVersion.findUniqueOrThrow({
      where: { id: job.resultStoryboardVersionId ?? '' },
      include: { scenes: { orderBy: { sceneNumber: 'asc' }, include: { referenceAssets: true } } },
    });
    expect(version).toMatchObject({
      scriptVersionId: scriptId,
      version: 1,
      status: 'pending_review',
    });
    expect(version.totalDurationSeconds.toFixed(2)).toBe('30.00');
    expect(version.scenes).toHaveLength(5);
    expect(version.scenes[0]).toMatchObject({
      characterVersionId: world.characterVersionId,
      environmentVersionId: world.environmentVersionId,
    });
    expect(version.scenes[0]?.referenceAssets.map((a) => a.assetId)).toEqual([world.assetId]);
    expect(await contentStatus()).toBe('storyboard_review');
    expect(mock.calls.at(-1)?.request.messages[1]?.content).toContain(world.characterVersionId);
  });

  it('rejects invented ids and wrong total duration', async () => {
    const scriptId = await approvedScript();
    const jobId = await createJob(
      prisma,
      world,
      'storyboard_generation',
      storyboardInput(world, scriptId),
    );
    const bad = sampleStoryboard(5, 9); // 45 s for a 30 s target
    bad.scenes[0] = sampleScene(1, {
      durationSeconds: 9,
      characterVersionId: '99999999-0000-7000-8000-000000000009',
    });
    mock.enqueue({ kind: 'result', text: json(bad) }, { kind: 'result', text: json(bad) });
    expect(await processor.process(jobId)).toEqual({ type: 'failed', errorCode: 'OUTPUT_INVALID' });
    expect(await prisma.storyboardVersion.count()).toBe(0);
    expect(await contentStatus()).toBe('script_review'); // restored to where the job started
  });
});

describe('errors and retries', () => {
  it('schedules a retry for a retryable error, honouring Retry-After, then succeeds on the next attempt', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({
      kind: 'error',
      error: providerError('RATE_LIMITED', ProviderErrorOutcome.REJECTED, 60_000),
    });
    expect(await processor.process(jobId)).toEqual({
      type: 'retry',
      errorCode: 'RATE_LIMITED',
      delayMs: 60_000,
    });
    let job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'queued', attempt: 1, errorCode: 'RATE_LIMITED' });
    expect(job.activeKey).not.toBeNull(); // still the active job
    expect(await contentStatus()).toBe('scripting');

    mock.enqueue({ kind: 'result', text: json(sampleScript()) });
    expect((await processor.process(jobId)).type).toBe('succeeded');
    job = await jobRow(jobId);
    expect(job).toMatchObject({ status: 'succeeded', attempt: 2 });
    const invocations = await prisma.aiInvocation.findMany({
      where: { generationJobId: jobId },
      orderBy: { startedAt: 'asc' },
    });
    expect(invocations.map((i) => [i.status, i.errorCode, i.idempotencyKey])).toEqual([
      ['failed', 'RATE_LIMITED', `${jobId}:1:1`],
      ['succeeded', null, `${jobId}:2:1`],
    ]);
  });

  it('uses exponential backoff with jitter when there is no Retry-After', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({
      kind: 'error',
      error: providerError('PROVIDER_UNAVAILABLE', ProviderErrorOutcome.REJECTED),
    });
    expect(await processor.process(jobId)).toMatchObject({ type: 'retry', delayMs: 5000 });
  });

  it.each([
    'AUTHENTICATION',
    'CONTENT_POLICY',
    'PROVIDER_BUDGET_EXCEEDED',
    'INVALID_REQUEST',
  ] as const)('never retries %s', async (code) => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'error', error: providerError(code, ProviderErrorOutcome.REJECTED) });
    expect(await processor.process(jobId)).toEqual({ type: 'failed', errorCode: code });
    expect(mock.calls).toHaveLength(1);
    expect(deadLetters).toHaveLength(1);
  });

  it('fails after the last attempt (bounded retries)', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    for (let i = 0; i < 3; i += 1)
      mock.enqueue({
        kind: 'error',
        error: providerError('TIMEOUT', ProviderErrorOutcome.UNKNOWN),
      });
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) outcomes.push((await processor.process(jobId)).type);
    expect(outcomes).toEqual(['retry', 'retry', 'failed', 'skipped']);
    expect(await jobRow(jobId)).toMatchObject({
      status: 'failed',
      attempt: 3,
      errorCode: 'TIMEOUT',
    });
    // A timed-out call may have been charged: each attempt is in the ledger as outcome_unknown.
    expect(
      await prisma.aiInvocation.count({
        where: { generationJobId: jobId, status: 'outcome_unknown' },
      }),
    ).toBe(3);
  });

  it('fails with NO_ELIGIBLE_MODEL when the model was disabled after the job was created', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.aiModel.update({ where: { id: world.modelId }, data: { status: 'disabled' } });
    expect(await processor.process(jobId)).toEqual({
      type: 'failed',
      errorCode: 'NO_ELIGIBLE_MODEL',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('fails with INVALID_JOB_INPUT for a malformed input', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    // Inputs are immutable (AC011); simulate an incompatible older job by creating one directly.
    const bad = await prisma.generationJob.create({
      data: {
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        productionRunId: (await jobRow(jobId)).productionRunId,
        kind: 'storyboard_generation',
        activeKey: `${world.contentItemId}:storyboard_generation`,
        idempotencyKey: 'bad-input',
        executionKey: 'f'.repeat(64),
        input: { unexpected: true },
        previousContentStatus: 'script_review',
        promptTemplateId: 'storyboard.v1',
        modelId: world.modelId,
        requestedById: world.userId,
      },
    });
    expect(await processor.process(bad.id)).toEqual({
      type: 'failed',
      errorCode: 'INVALID_JOB_INPUT',
    });
  });
});

describe('cancel, redelivery and restarts', () => {
  it('skips a job canceled before it started', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'canceled', activeKey: null, completedAt: new Date() },
    });
    expect(await processor.process(jobId)).toEqual({ type: 'skipped' });
    expect(mock.calls).toHaveLength(0);
  });

  it('discards the result of a job canceled during its LLM call, keeping its cost', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    const cancelling: LlmProvider = {
      providerKey: 'mock',
      supportedParameters: mock.supportedParameters,
      complete: async (request, context, signal) => {
        await prisma.generationJob.update({
          where: { id: jobId },
          data: { status: 'canceled', activeKey: null, completedAt: new Date() },
        });
        mock.enqueue({ kind: 'result', text: json(sampleScript()) });
        return mock.complete(request, context, signal);
      },
    };
    expect(await build(new Map([['mock', cancelling]])).process(jobId)).toEqual({
      type: 'discarded',
    });
    expect(await prisma.scriptVersion.count()).toBe(0);
    expect((await jobRow(jobId)).status).toBe('canceled');
    expect(
      await prisma.aiInvocation.count({ where: { generationJobId: jobId, status: 'succeeded' } }),
    ).toBe(1);
    expect((await jobRow(jobId)).events.at(-1)?.detail).toEqual({ type: 'result_discarded' });
  });

  it('treats a redelivered running job (worker died) as a new attempt', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });
    mock.enqueue({ kind: 'result', text: json(sampleScript()) });
    expect((await processor.process(jobId)).type).toBe('succeeded');
    const job = await jobRow(jobId);
    expect(job.attempt).toBe(2);
    expect(job.events.map((e) => (e.detail as { type: string }).type)).toContain(
      'stalled_recovered',
    );
  });

  it('fails with WORKER_LOST when the last attempt was interrupted', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 3, startedAt: new Date() },
    });
    expect(await processor.process(jobId)).toEqual({ type: 'failed', errorCode: 'WORKER_LOST' });
    expect(await contentStatus()).toBe('draft');
  });

  it('processes a job at most once when delivered twice concurrently', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue(
      { kind: 'result', text: json(sampleScript()) },
      { kind: 'result', text: json(sampleScript()) },
    );
    const outcomes = await Promise.all([processor.process(jobId), processor.process(jobId)]);
    expect(outcomes.map((o) => o.type).sort()).toEqual(['skipped', 'succeeded']);
    expect(await prisma.scriptVersion.count()).toBe(1);
  });
});
