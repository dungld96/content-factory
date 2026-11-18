// BullMQ + Redis end to end (M3 design §2, §8; ADR-0013): the real queue, worker, backoff
// strategy, dead-letter queue and reconciler, with a scripted mock LLM. Every run uses its own
// key prefix and removes it afterwards.
import { randomUUID } from 'node:crypto';

import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '@acf/ai-core';
import { MockLlmProvider } from '@acf/ai-core/testing';
import { LlmService, ModelCatalog } from '@acf/ai-runtime';
import type { GenerationJobPayload } from '@acf/content-domain';
import { sampleScript } from '@acf/content-domain/testing';
import type { PrismaClient } from '@acf/database';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { silentLogger } from '../src/logger.js';
import {
  addDeadLetter,
  createQueues,
  generationJobOptions,
  redisConnection,
  startGenerationWorker,
  type Queues,
} from '../src/queues.js';
import { Reconciler } from '../src/reconciler.js';
import {
  appPrisma,
  createJob,
  createWorld,
  migratorPrisma,
  reset,
  scriptInput,
  type World,
} from './support/fixtures.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const prefix = `acf-test-${randomUUID().slice(0, 8)}`;

let prisma: PrismaClient;
let migrator: PrismaClient;
let connection: Redis;
let queues: Queues;
let worker: Worker<GenerationJobPayload>;
let mock: MockLlmProvider;
let world: World;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await sleep(50);
  }
}
const jobStatus = (id: string) =>
  prisma.generationJob.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempt: true, errorCode: true },
  });
const terminal = (j: { status: string }) => ['succeeded', 'failed', 'canceled'].includes(j.status);

beforeAll(async () => {
  prisma = appPrisma();
  migrator = migratorPrisma();
  connection = redisConnection(REDIS_URL);
  queues = createQueues(connection, prefix);
  mock = new MockLlmProvider({ providerKey: 'mock' });
  const providers = new Map([['mock', mock]]);
  const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: 120_000,
  });
  const processor = new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm,
    deadLetter: (p) => addDeadLetter(queues, p),
    logger: silentLogger,
    retryDelay: () => 50, // keep the suite fast; the policy itself is unit-tested
  });
  worker = startGenerationWorker({
    connection,
    prefix,
    concurrency: 2,
    processor,
    logger: silentLogger,
  });
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await queues.generation.obliterate({ force: true });
  await queues.deadLetter.obliterate({ force: true });
  await queues.generation.close();
  await queues.deadLetter.close();
  connection.disconnect();
  await prisma.$disconnect();
  await migrator.$disconnect();
});

beforeEach(async () => {
  await reset(migrator);
  world = await createWorld(prisma);
});

const enqueue = (jobId: string) =>
  queues.generation.add('generate', { jobId }, generationJobOptions(jobId));

describe('BullMQ 6.7.7 with ioredis 6.0.0 on the local Redis', () => {
  it('processes an enqueued job to a schema-valid script version', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'result', text: JSON.stringify(sampleScript()) });
    await enqueue(jobId);
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({
      status: 'succeeded',
      attempt: 1,
    });
    const bull = await queues.generation.getJob(jobId);
    expect(await bull?.getState()).toBe('completed');
  });

  it('a duplicate enqueue of the same job id is a no-op', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'result', text: JSON.stringify(sampleScript()) });
    await Promise.all([enqueue(jobId), enqueue(jobId), enqueue(jobId)]);
    await waitFor(() => jobStatus(jobId), terminal);
    expect(await prisma.scriptVersion.count()).toBe(1);
    expect(await prisma.aiInvocation.count({ where: { generationJobId: jobId } })).toBe(1);
  });

  it('retries through BullMQ backoff after a retryable error, then succeeds', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue(
      {
        kind: 'error',
        error: new ProviderError(ProviderErrorCode.PROVIDER_UNAVAILABLE, 'down', {
          outcome: ProviderErrorOutcome.REJECTED,
        }),
      },
      { kind: 'result', text: JSON.stringify(sampleScript()) },
    );
    await enqueue(jobId);
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
    const bull = await queues.generation.getJob(jobId);
    expect(bull?.attemptsMade).toBe(2); // BullMQ 6 counts every started attempt, as the DB does
  });

  it('copies a final failure to the dead-letter queue; PostgreSQL holds the outcome', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({
      kind: 'error',
      error: new ProviderError(ProviderErrorCode.AUTHENTICATION, 'bad key', {
        outcome: ProviderErrorOutcome.REJECTED,
      }),
    });
    await enqueue(jobId);
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({
      status: 'failed',
      errorCode: 'AUTHENTICATION',
    });
    const dead = await waitFor(
      () => queues.deadLetter.getJob(`${jobId}-1`),
      (j) => j !== undefined,
    );
    expect(dead?.data).toMatchObject({ jobId, errorCode: 'AUTHENTICATION', attempt: 1 });
  });
});

describe('reconciler (outbox equivalent)', () => {
  it('enqueues a queued job that never reached Redis', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'result', text: JSON.stringify(sampleScript()) });
    const reconciler = new Reconciler(prisma, queues, silentLogger, { queuedGraceMs: 0 });
    expect(await reconciler.run(new Date(Date.now() + 1000))).toMatchObject({ enqueued: 1 });
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({ status: 'succeeded' });
    // A second run finds nothing to do.
    expect(await reconciler.run(new Date(Date.now() + 1000))).toEqual({
      enqueued: 0,
      requeued: 0,
      failed: 0,
    });
  });

  it('requeues a running job whose worker vanished, as a new attempt', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });
    mock.enqueue({ kind: 'result', text: JSON.stringify(sampleScript()) });
    const reconciler = new Reconciler(prisma, queues, silentLogger, { runningGraceMs: 0 });
    expect(await reconciler.run(new Date(Date.now() + 1000))).toMatchObject({ requeued: 1 });
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
  });

  it('fails a lost job that has no attempt left, via the normal failure path', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 3, startedAt: new Date() },
    });
    const reconciler = new Reconciler(prisma, queues, silentLogger, { runningGraceMs: 0 });
    expect(await reconciler.run(new Date(Date.now() + 1000))).toMatchObject({ failed: 1 });
    expect(await waitFor(() => jobStatus(jobId), terminal)).toMatchObject({
      status: 'failed',
      errorCode: 'WORKER_LOST',
    });
  });

  it('leaves live and delayed jobs alone', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await queues.generation.add(
      'generate',
      { jobId },
      { ...generationJobOptions(jobId), delay: 60_000 },
    );
    const reconciler = new Reconciler(prisma, queues, silentLogger, { queuedGraceMs: 0 });
    expect(await reconciler.run(new Date(Date.now() + 1000))).toEqual({
      enqueued: 0,
      requeued: 0,
      failed: 0,
    });
    await queues.generation.remove(jobId);
  });
});
