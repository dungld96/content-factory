// Failure drills through the real BullMQ queue and worker (M8 design §6): a provider outage
// opening the circuit (jobs deferred without using attempts, then recovered by the trial call),
// and Redis losing every queue key while jobs are queued and running (the reconciler rebuilds
// the queue from PostgreSQL). Each drill uses its own key prefix and removes it afterwards.
import { randomUUID } from 'node:crypto';

import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '@acf/ai-core';
import { MockLlmProvider } from '@acf/ai-core/testing';
import { CircuitBreaker, LlmService, ModelCatalog } from '@acf/ai-runtime';
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

let prisma: PrismaClient;
let migrator: PrismaClient;
let connection: Redis;
let prefix: string;
let queues: Queues;
let worker: Worker<GenerationJobPayload> | undefined;
let mock: MockLlmProvider;
let world: World;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 15_000,
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
const jobOf = (id: string) =>
  prisma.generationJob.findUniqueOrThrow({
    where: { id },
    select: { status: true, attempt: true, errorCode: true },
  });
const terminal = (j: { status: string }) => ['succeeded', 'failed', 'canceled'].includes(j.status);
const outage = () =>
  new ProviderError(ProviderErrorCode.PROVIDER_UNAVAILABLE, 'upstream 503', {
    outcome: ProviderErrorOutcome.REJECTED,
  });
const scriptResult = () =>
  ({
    kind: 'result',
    text: JSON.stringify(sampleScript()),
    usage: { inputTokens: 10, outputTokens: 10 },
  }) as const;

async function startWorker(circuits?: CircuitBreaker): Promise<void> {
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
    retryDelay: () => 50,
    ...(circuits ? { circuits } : {}),
  });
  worker = startGenerationWorker({
    connection,
    prefix,
    concurrency: 2,
    processor,
    logger: silentLogger,
  });
  await worker.waitUntilReady();
}

/** Deletes every key of this run's prefix: Redis lost its data. */
async function wipeRedis(): Promise<number> {
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await connection.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

beforeAll(() => {
  prisma = appPrisma();
  migrator = migratorPrisma();
  connection = redisConnection(REDIS_URL);
});

afterAll(async () => {
  connection.disconnect();
  await prisma.$disconnect();
  await migrator.$disconnect();
});

beforeEach(async () => {
  await reset(migrator);
  world = await createWorld(prisma);
  mock = new MockLlmProvider({ providerKey: 'mock' });
  prefix = `acf-drill-${randomUUID().slice(0, 8)}`;
  queues = createQueues(connection, prefix);
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  for (const queue of [
    queues.generation,
    queues.images,
    queues.videos,
    queues.audio,
    queues.renders,
    queues.deadLetter,
  ]) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

describe('drill: provider outage (circuit breaker)', () => {
  it('opens the circuit, defers work without using attempts, and recovers through one trial', async () => {
    const providerId = (await prisma.aiModel.findUniqueOrThrow({ where: { id: world.modelId } }))
      .providerId;
    const circuits = new CircuitBreaker(prisma, {
      policy: { failureThreshold: 2, openForMs: 600, trialWaitMs: 100 },
    });
    await startWorker(circuits);
    // Two failures open the circuit; the third delivery is deferred, then the trial succeeds.
    mock.enqueue({ kind: 'error', error: outage() });
    mock.enqueue({ kind: 'error', error: outage() });
    mock.enqueue(scriptResult());

    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await queues.generation.add('generate', { jobId }, generationJobOptions(jobId));

    await waitFor(
      () => prisma.providerCircuit.findUnique({ where: { providerId } }),
      (c) => c?.state === 'open',
    );
    const done = await waitFor(() => jobOf(jobId), terminal);
    expect(done).toEqual({ status: 'succeeded', attempt: 3, errorCode: null });
    expect(mock.calls).toHaveLength(3); // nothing was sent while the circuit was open
    // The circuit closes right after the job's own success transaction.
    await waitFor(
      () => prisma.providerCircuit.findUnique({ where: { providerId } }),
      (c) => c?.state === 'closed',
    );

    const events = await prisma.providerCircuitEvent.findMany({
      where: { providerId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => `${e.fromState}>${e.toState}:${e.reason}`)).toEqual([
      'closed>open:failures',
      'open>half_open:trial',
      'half_open>closed:trial_succeeded',
    ]);
    // The deferral used no attempt: one attempt_started per provider call.
    const attempts = await prisma.jobEvent.count({
      where: { jobId, detail: { path: ['type'], equals: 'attempt_started' } },
    });
    expect(attempts).toBe(3);
  });
});

describe('drill: Redis loses its data', () => {
  it('rebuilds the queue from PostgreSQL: queued, running and never-enqueued jobs all finish once', async () => {
    // Work exists before the loss: a queued job (in Redis), a running job (its worker died), and a
    // job whose enqueue never reached Redis; three content items, so they run side by side.
    const queued = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await queues.generation.add('generate', { jobId: queued }, generationJobOptions(queued));

    const other = await createWorld(prisma);
    const running = await createJob(prisma, other, 'script_generation', scriptInput(other));
    await prisma.generationJob.update({
      where: { id: running },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });

    const third = await createWorld(prisma);
    const neverEnqueued = await createJob(prisma, third, 'script_generation', scriptInput(third));

    expect(await wipeRedis()).toBeGreaterThan(0);
    expect(await queues.generation.getJobCounts('waiting', 'active', 'delayed')).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
    });

    for (let i = 0; i < 3; i += 1) mock.enqueue(scriptResult());
    await startWorker();
    const reconciler = new Reconciler(prisma, queues, silentLogger, {
      queuedGraceMs: 0,
      runningGraceMs: 0,
    });
    expect(await reconciler.run(new Date(Date.now() + 1000))).toMatchObject({
      enqueued: 2,
      requeued: 1,
      failed: 0,
    });

    for (const id of [queued, neverEnqueued]) {
      expect(await waitFor(() => jobOf(id), terminal)).toEqual({
        status: 'succeeded',
        attempt: 1,
        errorCode: null,
      });
    }
    expect(await waitFor(() => jobOf(running), terminal)).toEqual({
      status: 'succeeded',
      attempt: 2,
      errorCode: null,
    });
    // Exactly one result per job (no duplicate versions from the rebuilt queue).
    expect(
      await prisma.scriptVersion.count({
        where: { generationJobId: { in: [queued, running, neverEnqueued] } },
      }),
    ).toBe(3);
    // A second pass finds nothing left to repair.
    expect(await reconciler.run(new Date(Date.now() + 1000))).toEqual({
      enqueued: 0,
      requeued: 0,
      failed: 0,
      pollsResumed: 0,
    });
  });
});
