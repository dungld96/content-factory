// Worker process (M3 design §8, ADR-0013): `pnpm start:worker`. Consumes the `generation` queue,
// reconciles PostgreSQL with Redis, and sweeps abandoned LLM invocations at start-up.
import { createLlmProviders, LlmService, ModelCatalog } from '@acf/ai-runtime';
import { EnvValidationError, loadWorkerEnv, redactUrl, type WorkerEnv } from '@acf/config';
import { createPrismaClient } from '@acf/database';
import type { LlmProvider } from '@acf/ai-core';

import { GenerationProcessor } from './generation-processor.js';
import { JobStore } from './job-store.js';
import { createLogger, type LogLevel } from './logger.js';
import { addDeadLetter, createQueues, redisConnection, startGenerationWorker } from './queues.js';
import { Reconciler } from './reconciler.js';

const LEVELS: Readonly<Record<string, LogLevel>> = {
  fatal: 'error',
  error: 'error',
  warn: 'warn',
  log: 'info',
  debug: 'debug',
  verbose: 'debug',
};

export interface RunningWorker {
  stop(): Promise<void>;
}

/**
 * Starts a worker. `providers` defaults to the adapters configured in the environment; the E2E
 * harness passes a fixture provider instead (apps/worker/test).
 */
export async function startWorker(
  env: WorkerEnv,
  providers: ReadonlyMap<string, LlmProvider> = createLlmProviders(env),
): Promise<RunningWorker> {
  const logger = createLogger(LEVELS[env.LOG_LEVEL] ?? 'info', env.LOG_JSON);
  const prisma = createPrismaClient({
    databaseUrl: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_MAX,
  });
  const connection = redisConnection(env.REDIS_URL);
  const queues = createQueues(connection, env.QUEUE_PREFIX);
  const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: env.OPENROUTER_TIMEOUT_MS,
  });

  // Best effort: a database that is briefly unavailable must not stop the worker from starting.
  try {
    const abandoned = await llm.markAbandoned();
    if (abandoned > 0) logger.log('warn', 'ai_invocations_abandoned', { count: abandoned });
  } catch (error) {
    logger.log('warn', 'abandoned_sweep_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  }

  const processor = new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm,
    deadLetter: (payload) => addDeadLetter(queues, payload),
    logger,
  });
  const worker = startGenerationWorker({
    connection,
    prefix: env.QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    processor,
    logger,
  });
  const reconciler = new Reconciler(prisma, queues, logger);
  const reconcile = () => {
    reconciler.run().catch((error: unknown) => {
      logger.log('error', 'reconcile_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    });
  };
  reconcile();
  const timer = setInterval(reconcile, env.WORKER_RECONCILE_INTERVAL_MS);
  logger.log('info', 'worker_started', {
    concurrency: env.WORKER_CONCURRENCY,
    database: redactUrl(env.DATABASE_URL),
    redis: redactUrl(env.REDIS_URL),
    providers: [...providers.keys()].join(',') || '(none configured)',
  });

  return {
    async stop() {
      clearInterval(timer);
      await worker.close();
      await queues.generation.close();
      await queues.deadLetter.close();
      connection.disconnect();
      await prisma.$disconnect();
      logger.log('info', 'worker_stopped');
    },
  };
}

async function main(): Promise<void> {
  let env: WorkerEnv;
  try {
    env = loadWorkerEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const running = await startWorker(env);
  const shutdown = () => {
    running.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1]?.endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(
      'worker failed to start:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exit(1);
  });
}
