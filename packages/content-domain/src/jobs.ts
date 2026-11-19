import { z } from 'zod';

/**
 * Contracts shared by the API (creates jobs) and the worker (runs them), M3 design §7–§8,
 * ADR-0013. No BullMQ dependency here: only names, payloads and policy.
 */
import { AUDIO_GENERATION_QUEUE, VIDEO_GENERATION_QUEUE } from './media.js';
import { RENDER_QUEUE } from './render.js';

export const GENERATION_QUEUE = 'generation';
export const GENERATION_DLQ = 'generation-dlq';
/**
 * Image jobs have their own queue (M4 design S4): separate concurrency, and a longer lock
 * because one synchronous image call can take minutes.
 */
export const IMAGE_GENERATION_QUEUE = 'generation-images';
/** BullMQ lock for image jobs: above the 240 s provider timeout (M4 design §3.2). */
export const IMAGE_JOB_LOCK_MS = 300_000;

/** The queue a job of `kind` is delivered on. */
export const queueForKind = (kind: string): string =>
  kind === 'image_generation'
    ? IMAGE_GENERATION_QUEUE
    : kind === 'video_generation'
      ? VIDEO_GENERATION_QUEUE
      : kind === 'tts_generation'
        ? AUDIO_GENERATION_QUEUE
        : kind === 'render'
          ? RENDER_QUEUE
          : GENERATION_QUEUE;

/** The BullMQ payload carries only the job id; PostgreSQL holds everything else. */
export const generationJobPayloadSchema = z.strictObject({ jobId: z.uuid() });
export type GenerationJobPayload = z.infer<typeof generationJobPayloadSchema>;

export const deadLetterPayloadSchema = z.strictObject({
  jobId: z.uuid(),
  errorCode: z.string(),
  attempt: z.number().int(),
  failedAt: z.iso.datetime(),
});
export type DeadLetterPayload = z.infer<typeof deadLetterPayloadSchema>;

const qualityTier = z.enum(['economy', 'balanced', 'premium']);

/** `generation_jobs.input` for script generation: everything the worker needs, fixed at creation. */
export const scriptJobInputSchema = z.strictObject({
  brief: z.strictObject({
    topic: z.string().min(1),
    audience: z.string().nullable(),
    objective: z.string().nullable(),
    tone: z.string().nullable(),
    callToAction: z.string().nullable(),
    notes: z.string().nullable(),
    sourceUrls: z.array(z.string()),
  }),
  targetDurationSeconds: z.number().int().positive(),
  language: z.string().min(2),
  aspectRatio: z.string(),
  claimFlags: z.array(z.string()),
  characterVersionId: z.uuid().nullable(),
  environmentVersionId: z.uuid().nullable(),
  qualityTier,
});
export type ScriptJobInput = z.infer<typeof scriptJobInputSchema>;

/** `generation_jobs.input` for storyboard generation. */
export const storyboardJobInputSchema = z.strictObject({
  scriptVersionId: z.uuid(),
  targetDurationSeconds: z.number().int().positive(),
  language: z.string().min(2),
  aspectRatio: z.string(),
  characterVersionIds: z.array(z.uuid()),
  environmentVersionIds: z.array(z.uuid()),
  qualityTier,
});
export type StoryboardJobInput = z.infer<typeof storyboardJobInputSchema>;

/** Output token ceilings per kind (bounds cost; scripts are short, storyboards longer). */
export const MAX_OUTPUT_TOKENS = { script_generation: 4000, storyboard_generation: 8000 } as const;

/** Retry policy (CLAUDE.md §7, ADR-0013): bounded, exponential, jittered, Retry-After honoured. */
export const RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  /** ± fraction of the exponential delay. */
  jitter: 0.5,
} as const;

/**
 * Delay before the next attempt after `attemptsMade` failed attempts:
 * `base × 2^(attemptsMade−1)`, jittered by ±50 %, capped, and never shorter than the provider's
 * `Retry-After`. `random` is injectable for tests.
 */
export function retryDelayMs(
  attemptsMade: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const exponential = RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attemptsMade - 1);
  const jittered = exponential * (1 + RETRY_POLICY.jitter * (2 * random() - 1));
  const delay = Math.min(RETRY_POLICY.maxDelayMs, Math.round(jittered));
  return Math.max(delay, retryAfterMs ?? 0);
}

/** Text generation kinds (M3); image generation (M4) is scene-scoped. */
export type TextJobKind = 'script_generation' | 'storyboard_generation';
export type GenerationKind =
  TextJobKind | 'image_generation' | 'video_generation' | 'tts_generation';

/** One active job per content item and kind (`generation_jobs.active_key`). */
export const activeJobKey = (contentItemId: string, kind: TextJobKind) =>
  `${contentItemId}:${kind}`;

/** One active image job per storyboard scene (M4 design §5.1). */
export const activeImageJobKey = (sceneId: string) => `${sceneId}:image_generation`;

/**
 * BullMQ options for a generation job, shared by the API (enqueue) and the worker (reconcile).
 * The BullMQ id is the DB id, so duplicate adds are no-ops; `backoff.type: 'acf'` selects the
 * worker's strategy, which applies the delay the processor decided (`retryDelayMs`).
 */
export const generationJobOptions = (jobId: string) => ({
  jobId,
  attempts: RETRY_POLICY.maxAttempts,
  backoff: { type: 'acf' },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
});

/** BullMQ job name of a video status read (the submit is named `generate`). */
export const VIDEO_POLL_JOB_NAME = 'poll';

/**
 * BullMQ options of poll number `pollCount` of a video job (M5 design §5.2). The id is unique per
 * poll, so a reconciler re-add of the same poll is a no-op; a poll is never retried by BullMQ
 * (the processor schedules the next one itself).
 */
export const videoPollOptions = (jobId: string, pollCount: number, delayMs: number) => ({
  jobId: `${jobId}-poll-${String(pollCount)}`,
  delay: Math.max(0, delayMs),
  attempts: 1,
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
});
