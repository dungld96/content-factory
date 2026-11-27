// M7b reliability in the worker against real PostgreSQL (M7 design §4, §5, §7, §10): the budget
// re-check before the paid call, reservation settlement, the circuit breaker per provider, and
// redaction of credentials in job rows and logs. No Redis: BullMQ wiring is in the queue tests.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '@acf/ai-core';
import { MockLlmProvider } from '@acf/ai-core/testing';
import { CIRCUIT_POLICY, CircuitBreaker, LlmService, ModelCatalog } from '@acf/ai-runtime';
import { sampleScript } from '@acf/content-domain/testing';
import type { PrismaClient } from '@acf/database';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { createLogger, silentLogger, type Logger } from '../src/logger.js';
import {
  appPrisma,
  createJob,
  createWorld,
  migratorPrisma,
  reset,
  scriptInput,
  type World,
} from './support/fixtures.js';

let prisma: PrismaClient;
let migrator: PrismaClient;
let world: World;
let mock: MockLlmProvider;
let providerId: string;

/** Stable fake job ids per label (circuit rows store job ids as UUIDs). */
const ids = new Map<string, string>();
const J = (label: string) => {
  if (!ids.has(label)) ids.set(label, randomUUID());
  return ids.get(label) ?? '';
};

const FAKE_SECRET = 'FAKE-SECRET-7f3a9c2e';

function build(logger: Logger = silentLogger, circuits?: CircuitBreaker): GenerationProcessor {
  const providers = new Map([['mock', mock]]);
  const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: 120_000,
  });
  return new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma, logger),
    llm,
    deadLetter: () => Promise.resolve(),
    logger,
    random: () => 0.5,
    retryDelay: () => 1,
    ...(circuits ? { circuits } : {}),
  });
}

/** Budget row and an open reservation of `amount` for the job, as the API writes them. */
async function reserve(jobId: string, amount: string, monthly = '10'): Promise<void> {
  await prisma.projectBudget.upsert({
    where: { projectId: world.projectId },
    create: {
      projectId: world.projectId,
      monthlyLimitUsd: monthly,
      itemLimitUsd: null,
      requestLimitUsd: null,
    },
    update: { monthlyLimitUsd: monthly },
  });
  await prisma.budgetReservation.create({
    data: {
      projectId: world.projectId,
      contentItemId: world.contentItemId,
      jobId,
      amountUsd: amount,
      kind: 'estimate',
    },
  });
}

const reservationOf = (jobId: string) =>
  prisma.budgetReservation.findUniqueOrThrow({ where: { jobId } });

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
  providerId = (await prisma.aiModel.findUniqueOrThrow({ where: { id: world.modelId } }))
    .providerId;
});

describe('budget re-check before the paid call (B4)', () => {
  it('fails a job whose budget was lowered after it was queued, without calling the provider', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await reserve(jobId, '0.5');
    await prisma.projectBudget.update({
      where: { projectId: world.projectId },
      data: { monthlyLimitUsd: '0.1' },
    });

    const outcome = await build().process(jobId);
    expect(outcome).toEqual({ type: 'failed', errorCode: 'BUDGET_EXCEEDED' });
    expect(mock.calls).toHaveLength(0);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: 'failed', errorCode: 'BUDGET_EXCEEDED' });
    expect(await reservationOf(jobId)).toMatchObject({ status: 'released' });
    const blocked = await prisma.budgetEvent.findFirstOrThrow({ where: { type: 'blocked' } });
    expect(blocked.detail).toMatchObject({
      jobId,
      scope: 'month',
      limitUsd: '0.1',
      requestedUsd: '0.5',
    });
  });

  it('runs a job that still fits, and settles its reservation on success', async () => {
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await reserve(jobId, '0.5', '0.5'); // exactly reaching the limit is allowed
    mock.enqueue({
      kind: 'result',
      text: JSON.stringify(sampleScript()),
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    expect((await build().process(jobId)).type).toBe('succeeded');
    const r = await reservationOf(jobId);
    expect(r.status).toBe('settled');
    expect(r.resolvedAt).not.toBeNull();
  });

  it('releases on a final failure and holds when the provider charge is unknown', async () => {
    const jobs = new JobStore(prisma);
    const failed = await createJob(prisma, world, 'script_generation', scriptInput(world));
    await reserve(failed, '0.2');
    const row = await prisma.generationJob.findUniqueOrThrow({ where: { id: failed } });
    expect(await jobs.fail(row, 'INVALID_REQUEST', 'refused')).toBe(true);
    expect(await reservationOf(failed)).toMatchObject({ status: 'released' });

    const unknown = await createJob(prisma, world, 'storyboard_generation', scriptInput(world));
    await prisma.budgetReservation.create({
      data: {
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        jobId: unknown,
        amountUsd: '1',
        kind: 'estimate',
      },
    });
    const row2 = await prisma.generationJob.findUniqueOrThrow({ where: { id: unknown } });
    expect(await jobs.fail(row2, 'SUBMIT_OUTCOME_UNKNOWN', 'lost')).toBe(true);
    expect(await reservationOf(unknown)).toMatchObject({ status: 'held', resolvedAt: null });
  });
});

describe('circuit breaker (B7)', () => {
  const transient = (code: string) =>
    new ProviderError(ProviderErrorCode.PROVIDER_UNAVAILABLE, code, {
      outcome: ProviderErrorOutcome.REJECTED,
    });

  it('opens after 5 counted failures, admits one trial when half-open, and reopens for longer', async () => {
    let now = new Date('2026-11-20T10:00:00Z');
    const transitions: string[] = [];
    const breaker = new CircuitBreaker(prisma, {
      now: () => now,
      onTransition: (t) => transitions.push(`${t.from}>${t.to}:${t.reason}`),
    });
    // Not counted: invalid requests and rate limits never open the circuit.
    await breaker.recordFailure(providerId, J('j0'), ProviderErrorCode.INVALID_REQUEST);
    await breaker.recordFailure(providerId, J('j0'), ProviderErrorCode.RATE_LIMITED);
    for (let i = 0; i < 4; i += 1)
      await breaker.recordFailure(providerId, J(`j${String(i)}`), 'TIMEOUT');
    expect(await breaker.admit(providerId, J('a'))).toEqual({ admitted: true });
    await breaker.recordFailure(providerId, J('j4'), 'PROVIDER_UNAVAILABLE');
    expect(transitions).toEqual(['closed>open:failures']);
    expect(await breaker.admit(providerId, J('a'))).toEqual({
      admitted: false,
      retryInMs: CIRCUIT_POLICY.openForMs,
    });

    now = new Date(now.getTime() + CIRCUIT_POLICY.openForMs);
    expect(await breaker.admit(providerId, J('trial-1'))).toEqual({ admitted: true });
    expect(await breaker.admit(providerId, J('other'))).toEqual({
      admitted: false,
      retryInMs: CIRCUIT_POLICY.trialWaitMs,
    });
    expect(await breaker.admit(providerId, J('trial-1'))).toEqual({ admitted: true });
    await breaker.recordFailure(providerId, J('trial-1'), 'TIMEOUT');
    const reopened = await prisma.providerCircuit.findUniqueOrThrow({ where: { providerId } });
    expect(reopened).toMatchObject({ state: 'open', openForMs: CIRCUIT_POLICY.openForMs * 2 });

    now = new Date(now.getTime() + CIRCUIT_POLICY.openForMs * 2);
    expect(await breaker.admit(providerId, J('trial-2'))).toEqual({ admitted: true });
    await breaker.recordSuccess(providerId, J('trial-2'));
    expect(await prisma.providerCircuit.findUniqueOrThrow({ where: { providerId } })).toMatchObject(
      {
        state: 'closed',
        consecutiveFailures: 0,
        openForMs: CIRCUIT_POLICY.openForMs,
        trialJobId: null,
      },
    );
    expect(transitions).toEqual([
      'closed>open:failures',
      'open>half_open:trial',
      'half_open>open:trial_failed',
      'open>half_open:trial',
      'half_open>closed:trial_succeeded',
    ]);
  });

  it('forgets failures older than the window and replaces a trial that never reported', async () => {
    let now = new Date('2026-11-20T10:00:00Z');
    const breaker = new CircuitBreaker(prisma, { now: () => now });
    for (let i = 0; i < 4; i += 1) await breaker.recordFailure(providerId, J('j'), 'TIMEOUT');
    now = new Date(now.getTime() + CIRCUIT_POLICY.failureWindowMs + 1);
    await breaker.recordFailure(providerId, J('j'), 'TIMEOUT');
    expect(await prisma.providerCircuit.findUniqueOrThrow({ where: { providerId } })).toMatchObject(
      {
        state: 'closed',
        consecutiveFailures: 1,
      },
    );

    await breaker.set(providerId, 'open', world.userId);
    now = new Date(now.getTime() + CIRCUIT_POLICY.openForMs);
    expect(await breaker.admit(providerId, J('lost-trial'))).toEqual({ admitted: true });
    now = new Date(now.getTime() + CIRCUIT_POLICY.trialTimeoutMs);
    expect(await breaker.admit(providerId, J('next'))).toEqual({ admitted: true });
    const events = await prisma.providerCircuitEvent.findMany({
      where: { providerId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.reason, e.actorId])).toEqual([
      ['manual', world.userId],
      ['trial', null],
      ['trial_expired', null],
    ]);
  });

  it('defers a job while the circuit is open, without using an attempt', async () => {
    const breaker = new CircuitBreaker(prisma);
    await breaker.set(providerId, 'open', null);
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));

    const outcome = await build(silentLogger, breaker).process(jobId);
    expect(outcome).toMatchObject({ type: 'deferred', errorCode: 'PROVIDER_CIRCUIT_OPEN' });
    expect(mock.calls).toHaveLength(0);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('counts the provider failures of jobs and resets on success', async () => {
    const breaker = new CircuitBreaker(prisma);
    const processor = build(silentLogger, breaker);
    const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
    mock.enqueue({ kind: 'error', error: transient('down') });
    expect((await processor.process(jobId)).type).toBe('retry');
    expect(await prisma.providerCircuit.findUniqueOrThrow({ where: { providerId } })).toMatchObject(
      {
        consecutiveFailures: 1,
        lastErrorCode: 'PROVIDER_UNAVAILABLE',
      },
    );
    mock.enqueue({
      kind: 'result',
      text: JSON.stringify(sampleScript()),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect((await processor.process(jobId)).type).toBe('succeeded');
    expect(await prisma.providerCircuit.findUniqueOrThrow({ where: { providerId } })).toMatchObject(
      {
        consecutiveFailures: 0,
      },
    );
  });
});

describe('redaction (B10)', () => {
  it('keeps credentials out of job rows and worker logs', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const info = vi.spyOn(console, 'info').mockImplementation(capture);
    const error = vi.spyOn(console, 'error').mockImplementation(capture);
    try {
      const logger = createLogger('debug', true);
      const jobId = await createJob(prisma, world, 'script_generation', scriptInput(world));
      // A provider error echoing a signed URL with embedded credentials (not a ProviderError
      // shape the adapter sanitizes on its own).
      mock.enqueue({
        kind: 'error',
        error: new ProviderError(
          ProviderErrorCode.INVALID_REQUEST,
          `rejected https://user:${FAKE_SECRET}@api.example.test/v1?api_key=${FAKE_SECRET}&x=1 token=${FAKE_SECRET}`,
          { outcome: ProviderErrorOutcome.REJECTED },
        ),
      });
      expect((await build(logger).process(jobId)).type).toBe('failed');
      logger.log('warn', 'probe', {
        authorization: `Bearer ${FAKE_SECRET}`,
        note: `key=${FAKE_SECRET}`,
      });

      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
      const invocations = await prisma.aiInvocation.findMany({ where: { generationJobId: jobId } });
      const leaks = lines.filter((l) => l.includes(FAKE_SECRET));
      expect(leaks).toEqual([]);
      expect(job.errorMessage).not.toContain(FAKE_SECRET);
      const stored = JSON.stringify({ job, invocations, lines }, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(lines.length).toBeGreaterThan(0);
      expect(stored).not.toContain(FAKE_SECRET);
      expect(job.errorMessage).toContain('[redacted]');
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });
});
