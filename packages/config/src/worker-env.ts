import { z } from 'zod';

import { aiProviderEnvShape, checkAiProviderEnv } from './ai-provider-env.js';
import { mediaEnvShape } from './media-env.js';
import { checkStorageEnv, storageEnvShape } from './storage-env.js';
import { EnvValidationError, toEnvIssues } from './errors.js';
import {
  booleanStringSchema,
  logLevelSchema,
  nodeEnvSchema,
  urlWithProtocol,
} from './schema-helpers.js';

/**
 * Environment contract for `apps/worker` (M3 design §8, ADR-0013). Shares the AI provider
 * variables with the API so both validate them identically.
 */
export const workerEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    LOG_LEVEL: logLevelSchema,
    LOG_JSON: booleanStringSchema.default(true),
    DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:'], 'DATABASE_URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    REDIS_URL: urlWithProtocol(['redis:', 'rediss:'], 'REDIS_URL'),
    /** Jobs processed in parallel by this process. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    /** How often the reconciler re-enqueues orphaned jobs (outbox equivalent). */
    WORKER_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** BullMQ key prefix; tests isolate themselves with their own prefix. */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9:_-]{1,32}$/)
      .default('acf'),
    ...aiProviderEnvShape,
    ...storageEnvShape,
    ...mediaEnvShape,
    /** Image generation jobs processed in parallel (separate from text jobs; M4 design S4). */
    WORKER_IMAGE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    /** Video submit/poll/download steps (M5): short, so more in parallel. */
    WORKER_VIDEO_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    /**
     * Multiplies the video poll schedule (15 s, 30 s, 60 s …). Tests and E2E use a small factor
     * so mock clips finish in seconds; production keeps 1.
     */
    WORKER_VIDEO_POLL_SCALE: z.coerce.number().min(0.001).max(1).default(1),
    /** Renders processed in parallel (M6): CPU-bound, 1 on the single staging VM. */
    WORKER_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    /** Ceiling per FFmpeg step of a render (M6). */
    RENDER_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
    /** TTS calls (M5). */
    WORKER_AUDIO_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  })
  .superRefine((env, ctx) => {
    checkAiProviderEnv(env, ctx);
    checkStorageEnv(env, ctx);
  });

export type WorkerEnv = z.output<typeof workerEnvSchema>;

/** @throws {EnvValidationError} with variable names and problems (never values). */
export function loadWorkerEnv(source: Readonly<Record<string, string | undefined>>): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) throw new EnvValidationError('worker', toEnvIssues(result.error));
  return result.data;
}
