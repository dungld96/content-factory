import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  isProviderError,
  ProviderErrorOutcome,
  TERMINAL_VIDEO_STATUSES,
  type GenerationContext,
  type VideoJobState,
  type VideoRequest,
} from '@acf/ai-core';
import type { TtsService, VideoService } from '@acf/ai-runtime';
import {
  buildVideoPrompt,
  MAX_CLIP_BYTES,
  ttsJobInputSchema,
  type TtsJobInput,
  VIDEO_POLL_LIMIT_MS,
  VIDEO_PROMPT_TEMPLATE_ID,
  videoJobInputSchema,
  videoFailureCode,
  videoPollDelayMs,
  type JobErrorCode,
  type VideoJobInput,
} from '@acf/content-domain';
import type { GenerationJob, PrismaClient } from '@acf/database';
import {
  DEFAULT_MEDIA_TOOLS,
  AUDIO_LIMITS,
  inspectAudio,
  inspectVideoFile,
  MediaToolsMissingError,
  MediaValidationError,
  sniffContainer,
  type SniffedContainer,
  type MediaTools,
} from '@acf/media';
import {
  assetObjectKey,
  sha256Hex,
  StorageError,
  uuidv7,
  type ObjectStore,
  type StoredMimeType,
} from '@acf/storage';

import type { JobStore, StagedOutput } from './job-store.js';
import type { Logger } from './logger.js';
import type { MediaToolsGate } from './media-tools-gate.js';

/** Outcomes of media steps that are not plain success (the processor maps them to BullMQ). */
export type MediaStepOutcome =
  | { readonly type: 'submitted'; readonly providerJobId: string }
  | { readonly type: 'polling'; readonly pollCount: number }
  | { readonly type: 'succeeded'; readonly versionId: string }
  | { readonly type: 'failed'; readonly errorCode: string }
  | { readonly type: 'skipped' };

/** A job that cannot succeed as configured or as received: never retried. */
export class MediaPermanentError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The job is no longer this running attempt (canceled meanwhile): drop the result. */
export class MediaDiscardedError extends Error {}

export interface MediaJobsDeps {
  readonly prisma: PrismaClient;
  readonly jobs: JobStore;
  readonly store: ObjectStore | null;
  readonly videos?: VideoService | undefined;
  readonly tts?: TtsService | undefined;
  /** Adds poll number `pollCount` of a video job to the queue after `delayMs`. */
  readonly schedulePoll?:
    ((jobId: string, pollCount: number, delayMs: number) => Promise<void>) | undefined;
  readonly tools?: MediaTools | undefined;
  /** Checked before every paid clip or TTS call (P3d R6); absent in tests that stub the tools. */
  readonly toolsGate?: MediaToolsGate | undefined;
  readonly logger: Logger;
  readonly now?: (() => Date) | undefined;
  /** Waits between storage retries after a paid delivery (P3d R5); tests pass zeros. */
  readonly storageRetryDelaysMs?: readonly number[] | undefined;
  /** Factor applied to the poll schedule (`WORKER_VIDEO_POLL_SCALE`; tests and E2E only). */
  readonly pollScale?: number | undefined;
}

/** How the processor finishes a job (dead letter, content status) and handles other errors. */
export interface MediaOutcomes {
  readonly failFinal: (
    job: GenerationJob,
    code: JobErrorCode,
    message: string,
  ) => Promise<MediaStepOutcome>;
}

const RATIO: Readonly<Record<string, number>> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 };
const MAX_KEYFRAME_BYTES = 20 * 1024 * 1024;

/**
 * Video and TTS jobs (M5 design §5–§7). PostgreSQL is authoritative: the submission intent is
 * recorded before the paid call, the provider job id right after it, and every poll and outcome
 * is recorded. A submission that may have reached the provider is never resent automatically.
 */
export class MediaJobs {
  constructor(
    private readonly deps: MediaJobsDeps,
    private readonly outcomes: MediaOutcomes,
  ) {}

  private pollDelay(pollCount: number): number {
    return Math.round(videoPollDelayMs(pollCount) * (this.deps.pollScale ?? 1));
  }

  /** Refuses the job before its paid call while FFmpeg or FFprobe is missing (P3d R6). */
  private async assertToolsBeforePaying(): Promise<void> {
    const missing = await this.deps.toolsGate?.missing();
    if (missing) {
      throw new MediaPermanentError(
        'MEDIA_TOOLS_MISSING',
        `${missing} is not installed on the worker; nothing was sent to the provider`,
      );
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private context(
    job: GenerationJob,
    qualityTier: GenerationContext['qualityTier'],
  ): GenerationContext {
    return {
      projectId: job.projectId,
      contentItemId: job.contentItemId,
      generationJobId: job.id,
      correlationId: job.id,
      qualityTier,
    };
  }

  // ------------------------------------------------------------------- video: submit

  private async request(job: GenerationJob, input: VideoJobInput): Promise<VideoRequest> {
    const { prisma } = this.deps;
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const keyframe = await prisma.asset.findFirst({
      where: { id: input.keyframeAssetId, projectId: job.projectId },
      select: { storageKey: true, mimeType: true },
    });
    const bytes = keyframe ? await store.getBytes(keyframe.storageKey, MAX_KEYFRAME_BYTES) : null;
    if (!keyframe || !bytes) {
      throw new MediaPermanentError(
        'REFERENCE_MISSING',
        `keyframe ${input.keyframeAssetId} has no stored file`,
      );
    }
    const model = await prisma.aiModel.findUniqueOrThrow({
      where: { id: job.modelId },
      select: { modelKey: true },
    });
    return {
      modelKey: model.modelKey,
      prompt: buildVideoPrompt({ scene: input.scene, aspectRatio: input.aspectRatio }),
      durationSeconds: input.durationSeconds,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      generateAudio: input.generateAudio,
      ...(input.seed === null ? {} : { seed: input.seed }),
      firstFrame: {
        mimeType: keyframe.mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes,
      },
    };
  }

  /** Submits once (decision V3) and schedules the first poll. */
  async submitVideo(job: GenerationJob): Promise<MediaStepOutcome> {
    const videos = this.deps.videos;
    if (!videos)
      throw new MediaPermanentError('NO_ELIGIBLE_MODEL', 'no video providers are configured');
    const input = videoJobInputSchema.parse(job.input);
    await this.assertToolsBeforePaying();
    const request = await this.request(job, input);
    await this.deps.jobs.recordPrompt(job.id, `### ${VIDEO_PROMPT_TEMPLATE_ID}\n${request.prompt}`);
    let submission;
    try {
      submission = await videos.submit(this.context(job, input.qualityTier), request, {
        idempotencyKey: `${job.id}:${String(job.attempt)}:0`,
        beforeSubmit: async (invocationId, providerKey) => {
          if (!(await this.deps.jobs.markSubmitting(job, invocationId, providerKey))) {
            throw new MediaDiscardedError();
          }
        },
      });
    } catch (error) {
      if (error instanceof MediaDiscardedError) throw error;
      if (isProviderError(error)) {
        if (error.outcome === ProviderErrorOutcome.UNKNOWN) {
          // The job may exist at the provider and will be charged: never resend automatically.
          return this.outcomes.failFinal(
            job,
            'SUBMIT_OUTCOME_UNKNOWN',
            'the video submission could not be confirmed; regenerating may be charged twice',
          );
        }
        // Refused or never sent: nothing was accepted, so the attempt may be retried.
        await this.deps.jobs.clearSubmission(job, error.code);
      }
      throw error;
    }
    const delayMs = this.pollDelay(0);
    await this.deps.jobs.recordProviderJob(
      job,
      submission.state,
      new Date(this.now().getTime() + delayMs),
    );
    await this.schedulePoll(job.id, 0, delayMs);
    this.deps.logger.log('info', 'video_submitted', {
      jobId: job.id,
      providerJobId: submission.state.providerJobId,
    });
    return { type: 'submitted', providerJobId: submission.state.providerJobId };
  }

  private async schedulePoll(jobId: string, pollCount: number, delayMs: number): Promise<void> {
    if (!this.deps.schedulePoll) throw new Error('no poll scheduler configured');
    await this.deps.schedulePoll(jobId, pollCount, delayMs);
  }

  /**
   * A video job delivered again while its submission intent is recorded (worker restart,
   * reconciler): resume polling when the provider job id is known; otherwise the submission may
   * have been accepted, so the job fails with SUBMIT_OUTCOME_UNKNOWN instead of resending.
   */
  async resumeVideo(job: GenerationJob): Promise<MediaStepOutcome> {
    if (job.providerJobId) {
      await this.schedulePoll(job.id, job.pollCount, 0);
      return { type: 'polling', pollCount: job.pollCount };
    }
    if (job.invocationId && this.deps.videos) {
      await this.deps.videos
        .abandon(
          job.invocationId,
          'SUBMIT_OUTCOME_UNKNOWN',
          'the worker stopped during the submit call',
        )
        .catch(() => undefined); // already has an outcome
    }
    return this.outcomes.failFinal(
      job,
      'SUBMIT_OUTCOME_UNKNOWN',
      'the worker stopped during the video submission; regenerating may be charged twice',
    );
  }

  // ------------------------------------------------------------------- video: poll

  /** One status read; on completion download, validate, store and succeed. */
  async pollVideo(jobId: string): Promise<MediaStepOutcome> {
    const { jobs } = this.deps;
    const job = await jobs.load(jobId);
    if (
      !job ||
      job.status !== 'running' ||
      !job.providerJobId ||
      !job.providerKey ||
      !job.invocationId
    ) {
      return { type: 'skipped' };
    }
    const videos = this.deps.videos;
    if (!videos)
      throw new MediaPermanentError('NO_ELIGIBLE_MODEL', 'no video providers are configured');
    const input = videoJobInputSchema.parse(job.input);
    const context = this.context(job, input.qualityTier);
    const elapsed = this.now().getTime() - (job.submittedAt ?? this.now()).getTime();

    let state: VideoJobState | null = null;
    try {
      state = await videos.poll(job.providerKey, job.providerJobId, context);
    } catch (error) {
      // A status read costs nothing: keep following the job (bounded by the poll limit).
      this.deps.logger.log('warn', 'video_poll_failed', {
        jobId,
        error: isProviderError(error)
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
      });
    }
    if (state && TERMINAL_VIDEO_STATUSES.has(state.status)) {
      return this.terminal(job, input, state);
    }
    if (elapsed > VIDEO_POLL_LIMIT_MS) {
      await jobs.recordPoll(job, state, null);
      await videos.abandon(
        job.invocationId,
        'PROVIDER_TIMEOUT',
        'stopped following the provider job',
      );
      return this.outcomes.failFinal(
        job,
        'PROVIDER_TIMEOUT',
        `the provider did not finish within ${String(VIDEO_POLL_LIMIT_MS / 3_600_000)} h; it may still charge`,
      );
    }
    const delayMs = this.pollDelay(job.pollCount + 1);
    const pollCount = await jobs.recordPoll(job, state, new Date(this.now().getTime() + delayMs));
    if (pollCount === null) return { type: 'skipped' };
    await this.schedulePoll(job.id, pollCount, delayMs);
    return { type: 'polling', pollCount };
  }

  private async terminal(
    job: GenerationJob,
    input: VideoJobInput,
    state: VideoJobState,
  ): Promise<MediaStepOutcome> {
    const videos = this.deps.videos;
    const invocationId = job.invocationId;
    if (!videos || !invocationId || !job.providerKey) return { type: 'skipped' };
    if (state.status !== 'completed') {
      const code = videoFailureCode(
        state.status === 'cancelled' || state.status === 'expired' ? state.status : 'failed',
      );
      const message = state.error ?? `the provider reported ${state.status}`;
      await this.deps.jobs.recordPoll(job, state, null);
      await videos.fail(invocationId, state, code, message);
      return this.outcomes.failFinal(job, code, message);
    }
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    // P3d: after a restart following delivery, carry on from the stored file (never download or
    // record the cost twice).
    if (job.deliveredAt) return this.finishVideo(job, job, input, state);
    const dir = await mkdtemp(path.join(tmpdir(), 'acf-clip-'));
    try {
      const file = path.join(dir, 'clip.bin');
      let contentType: string | null;
      try {
        const download = await videos.download(
          job.providerKey,
          state.providerJobId,
          0,
          this.context(job, input.qualityTier),
        );
        contentType = download.contentType;
        let total = 0;
        const limited = Readable.from(
          (async function* () {
            for await (const chunk of download.body) {
              total += chunk.byteLength;
              if (total > MAX_CLIP_BYTES)
                throw new MediaValidationError('MEDIA_TOO_LARGE', 'clip larger than 200 MB');
              yield chunk;
            }
          })(),
        );
        await pipeline(limited, createWriteStream(file, { mode: 0o600 }));
      } catch (error) {
        if (error instanceof MediaValidationError) throw error;
        if (isProviderError(error) && !error.retryable) {
          // 404/410: the provider no longer has the output (expired). The cost is already incurred.
          await this.deps.jobs.recordPoll(job, state, null);
          await videos.fail(invocationId, state, 'OUTPUT_EXPIRED', error.message);
          return await this.outcomes.failFinal(
            job,
            'OUTPUT_EXPIRED',
            'the provider deleted the clip before it was downloaded',
          );
        }
        // Network trouble: download again on the next poll.
        const delayMs = this.pollDelay(1);
        const pollCount = await this.deps.jobs.recordPoll(
          job,
          state,
          new Date(this.now().getTime() + delayMs),
        );
        if (pollCount === null) return { type: 'skipped' };
        await this.schedulePoll(job.id, pollCount, delayMs);
        return { type: 'polling', pollCount };
      }

      const bytes = new Uint8Array(await readFile(file));
      // P3d R2: the clip is delivered: its cost is final whatever happens next.
      const request = await this.request(job, input);
      await videos.complete(invocationId, request, state);
      const staged = await this.stage(job, bytes, 'video');
      if (staged === 'unsupported') {
        await this.deps.jobs.recordPoll(job, state, null);
        return await this.outcomes.failFinal(
          job,
          'OUTPUT_INVALID',
          'the clip failed validation: not an MP4, MOV or WebM video',
        );
      }
      if (staged === 'not_stored') {
        await this.deps.jobs.recordPoll(job, state, null);
        return await this.outcomes.failFinal(
          job,
          'STORAGE_UNAVAILABLE',
          'the clip was delivered but could not be stored; finish it once storage is back (no new charge)',
        );
      }
      return await this.validateAndStoreVideo(job, job, input, file, contentType, staged, state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Validates a delivered clip (the running job's, or a failed job's for a finish job) from its
   * stored copy and creates the asset (P3d R3). Never calls the provider.
   */
  private async finishVideo(
    job: GenerationJob,
    paid: GenerationJob,
    input: VideoJobInput,
    state: VideoJobState | null,
  ): Promise<MediaStepOutcome> {
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const staged = stagedOf(paid);
    if (!staged) {
      throw new MediaPermanentError(
        'OUTPUT_NOT_STORED',
        'the delivered clip was not stored; regenerate it',
      );
    }
    const bytes = await readStaged(store, staged, MAX_CLIP_BYTES);
    const dir = await mkdtemp(path.join(tmpdir(), 'acf-clip-'));
    try {
      const file = path.join(dir, 'clip.bin');
      await writeFile(file, bytes, { mode: 0o600 });
      return await this.validateAndStoreVideo(job, paid, input, file, null, staged, state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async validateAndStoreVideo(
    job: GenerationJob,
    paid: GenerationJob,
    input: VideoJobInput,
    file: string,
    contentType: string | null,
    staged: StagedOutput,
    state: VideoJobState | null,
  ): Promise<MediaStepOutcome> {
    let clip;
    try {
      clip = await inspectVideoFile(
        file,
        contentType,
        {
          aspectRatio: RATIO[input.aspectRatio] ?? 9 / 16,
          minDurationMs: Math.floor(input.durationSeconds * 900),
          maxBytes: MAX_CLIP_BYTES,
        },
        this.deps.tools ?? DEFAULT_MEDIA_TOOLS,
      );
    } catch (error) {
      if (error instanceof MediaValidationError) {
        // Paid already (cost recorded at delivery): never resubmitted; the user may regenerate.
        if (state) await this.deps.jobs.recordPoll(job, state, null);
        return await this.outcomes.failFinal(
          job,
          'OUTPUT_INVALID',
          `the clip failed validation: ${error.message}`,
        );
      }
      if (error instanceof MediaToolsMissingError) {
        throw new MediaPermanentError(
          'MEDIA_TOOLS_MISSING',
          'FFprobe is not installed on the worker; the delivered clip is kept: install it, then finish (no new charge)',
        );
      }
      throw error;
    }
    const model = await this.deps.prisma.aiModel.findUniqueOrThrow({
      where: { id: paid.modelId },
      select: { modelKey: true },
    });
    const id = staged.assetId;
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.asset.create({
        data: {
          id,
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          assetType: 'video',
          sourceType: 'generated',
          // The job that paid for the clip (a finish job only validates and stores it).
          generationJobId: paid.id,
          storyboardSceneId: input.sceneId,
          storageKey: staged.objectKey,
          mimeType: clip.mimeType,
          sizeBytes: BigInt(clip.sizeBytes),
          checksumSha256: clip.sha256Hex,
          width: clip.width,
          height: clip.height,
          durationMs: clip.durationMs,
          label: `Scene ${String(input.scene.sceneNumber)} clip`,
          metadata: {
            clipHash: input.clipHash,
            model: model.modelKey,
            requestedSeconds: input.durationSeconds,
            resolution: input.resolution,
            video: {
              codec: clip.codec,
              fps: clip.fps,
              bitRate: clip.bitRate,
              hasAudio: clip.hasAudio,
              audioCodec: clip.audioCodec,
            },
          },
          createdById: job.requestedById,
        },
      });
      await tx.assetInput.create({
        data: {
          projectId: job.projectId,
          assetId: id,
          inputAssetId: input.keyframeAssetId,
          role: 'keyframe',
        },
      });
      if (state) {
        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            providerStatus: state.status,
            pollCount: job.pollCount + 1,
            lastPolledAt: this.now(),
            nextPollAt: null,
          },
        });
      }
      if (!(await this.deps.jobs.succeedSceneJobIn(tx, job, [id]))) throw new MediaDiscardedError();
    });
    this.deps.logger.log('info', 'video_completed', { jobId: job.id, assetId: id });
    return { type: 'succeeded', versionId: id };
  }

  // ------------------------------------------------------------------- finish jobs (P3d R3, R4)

  /** The failed job whose delivered output a finish job completes. */
  private async paidJobOf(job: GenerationJob): Promise<GenerationJob> {
    const paid = job.recoverFromJobId
      ? await this.deps.prisma.generationJob.findUnique({ where: { id: job.recoverFromJobId } })
      : null;
    if (!paid?.deliveredAt || paid.kind !== job.kind) {
      throw new MediaPermanentError('INVALID_JOB_INPUT', 'the job to finish has no delivered output');
    }
    return paid;
  }

  /**
   * Finishes a clip from its delivered file, or (when it was never stored) from the provider's
   * copy: a download is a free read of a job already paid for (R4). Never submits.
   */
  async finishVideoJob(job: GenerationJob): Promise<MediaStepOutcome> {
    const paid = await this.paidJobOf(job);
    const input = videoJobInputSchema.parse(job.input);
    if (stagedOf(paid)) return this.finishVideo(job, paid, input, null);
    const videos = this.deps.videos;
    if (!videos || !paid.providerKey || !paid.providerJobId) {
      throw new MediaPermanentError(
        'OUTPUT_NOT_STORED',
        'the delivered clip was not stored and cannot be downloaded again; regenerate it',
      );
    }
    if (paid.providerExpiresAt && paid.providerExpiresAt.getTime() <= this.now().getTime()) {
      throw new MediaPermanentError(
        'OUTPUT_EXPIRED',
        'the provider no longer keeps the clip; regenerate it',
      );
    }
    let bytes: Uint8Array;
    try {
      const download = await videos.download(
        paid.providerKey,
        paid.providerJobId,
        0,
        this.context(job, input.qualityTier),
      );
      bytes = await readStream(download.body, MAX_CLIP_BYTES);
    } catch (error) {
      if (isProviderError(error) && !error.retryable) {
        throw new MediaPermanentError(
          'OUTPUT_EXPIRED',
          'the provider no longer keeps the clip; regenerate it',
        );
      }
      throw error;
    }
    const staged = await this.stage(job, bytes, 'video');
    if (staged === 'unsupported') {
      return this.outcomes.failFinal(job, 'OUTPUT_INVALID', 'the clip failed validation: not an MP4, MOV or WebM video');
    }
    if (staged === 'not_stored') {
      throw new MediaPermanentError(
        'STORAGE_UNAVAILABLE',
        'storage is still unavailable; finish again later (no new charge)',
      );
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'acf-clip-'));
    try {
      const file = path.join(dir, 'clip.bin');
      await writeFile(file, bytes, { mode: 0o600 });
      return await this.validateAndStoreVideo(job, paid, input, file, null, staged, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Finishes a voice-over from its delivered file (never synthesizes). */
  async finishTts(job: GenerationJob): Promise<string> {
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const paid = await this.paidJobOf(job);
    const staged = stagedOf(paid);
    if (!staged) {
      throw new MediaPermanentError(
        'OUTPUT_NOT_STORED',
        'the delivered voice-over was not stored; regenerate it',
      );
    }
    const input = ttsJobInputSchema.parse(job.input);
    const bytes = await readStaged(store, staged, AUDIO_LIMITS.maxBytes);
    // The character count is on the paid job's invocation (ledger); not repeated here.
    return this.validateAndStoreAudio(job, paid, input, bytes, staged, null);
  }

  // ------------------------------------------------------------------- delivery (P3d)

  /**
   * Stores a delivered output at its final asset key before anything else happens to it (P3d R1)
   * and records the delivery on the job. Storage outages are retried in place (R5): the bytes are
   * paid for and must not be fetched again. Returns `not_stored` when storage stayed down.
   */
  private async stage(
    job: GenerationJob,
    bytes: Uint8Array,
    kind: 'video' | 'audio',
  ): Promise<StagedOutput | 'not_stored' | 'unsupported'> {
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const mimeType = stagedMimeType(kind, bytes);
    if (!mimeType) {
      // Not a format we accept: nothing to keep (the job ends OUTPUT_INVALID, cost recorded).
      await this.deps.jobs.recordDelivery(job, null);
      return 'unsupported';
    }
    const assetId = uuidv7();
    const digest = sha256Hex(bytes);
    const objectKey = assetObjectKey({
      projectId: job.projectId,
      assetId,
      sha256Hex: digest,
      mimeType,
    });
    const delays = this.deps.storageRetryDelaysMs ?? STORAGE_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await store.putIfAbsent(objectKey, bytes, { contentType: mimeType, sha256Hex: digest });
        break;
      } catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof StorageError) || error.code !== 'STORAGE_UNAVAILABLE') throw error;
        if (delay === undefined) {
          this.deps.logger.log('error', 'delivered_output_not_stored', { jobId: job.id });
          await this.deps.jobs.recordDelivery(job, null);
          return 'not_stored';
        }
        await sleep(jitter(delay));
      }
    }
    const result: StagedOutput = { assetId, objectKey, sha256Hex: digest, mimeType };
    if (!(await this.deps.jobs.recordDelivery(job, result))) throw new MediaDiscardedError();
    return result;
  }

  // ------------------------------------------------------------------- TTS

  /**
   * One voice-over: synthesize, store as delivered, validate with FFprobe, succeed (M5 design
   * §7.2, P3d). Once the audio is delivered, every failure is final for this job (never a second
   * paid call); environmental failures can be finished from the stored file.
   */
  async runTts(job: GenerationJob): Promise<string> {
    const tts = this.deps.tts;
    if (!tts) throw new MediaPermanentError('NO_ELIGIBLE_MODEL', 'no TTS providers are configured');
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    if (job.recoverFromJobId) return this.afterDelivery(() => this.finishTts(job));
    const input = ttsJobInputSchema.parse(job.input);
    await this.assertToolsBeforePaying();
    const model = await this.deps.prisma.aiModel.findUniqueOrThrow({
      where: { id: job.modelId },
      select: { modelKey: true },
    });
    await this.deps.jobs.recordPrompt(
      job.id,
      `### tts.v1 (${input.voice.voice}, ${input.voice.language})\n${input.text}`,
    );
    const { result } = await tts.synthesize(
      this.context(job, input.qualityTier),
      {
        modelKey: model.modelKey,
        text: input.text,
        voice: input.voice.voice,
        language: input.voice.language,
        ...(input.voice.speed === null ? {} : { speed: input.voice.speed }),
        ...(input.voice.instructions === null ? {} : { instructions: input.voice.instructions }),
        // Decision V2: narration text goes only to zero-data-retention endpoints.
        dataPolicy: { zeroDataRetention: true },
      },
      { idempotencyKey: `${job.id}:${String(job.attempt)}:0` },
    );
    return this.afterDelivery(async () => {
      const staged = await this.stage(job, result.bytes, 'audio');
      if (staged === 'unsupported') {
        throw new MediaPermanentError(
          'OUTPUT_INVALID',
          'the audio failed validation: only MP3, WAV and M4A/AAC audio is accepted',
        );
      }
      if (staged === 'not_stored') {
        throw new MediaPermanentError(
          'OUTPUT_NOT_STORED',
          'the voice-over was paid for but could not be stored',
        );
      }
      return this.validateAndStoreAudio(job, job, input, result.bytes, staged, result.characters);
    });
  }

  /** Validates a stored voice-over and creates the asset; never calls the provider. */
  private async validateAndStoreAudio(
    job: GenerationJob,
    paid: GenerationJob,
    input: TtsJobInput,
    bytes: Uint8Array,
    staged: StagedOutput,
    characters: number | null,
  ): Promise<string> {
    let audio;
    try {
      audio = await inspectAudio(bytes, staged.mimeType, {
        tools: this.deps.tools ?? DEFAULT_MEDIA_TOOLS,
      });
    } catch (error) {
      if (error instanceof MediaValidationError)
        throw new MediaPermanentError(
          'OUTPUT_INVALID',
          `the audio failed validation: ${error.message}`,
        );
      if (error instanceof MediaToolsMissingError)
        throw new MediaPermanentError(
          'MEDIA_TOOLS_MISSING',
          'FFprobe is not installed on the worker; the delivered voice-over is kept: install it, then finish (no new charge)',
        );
      throw error;
    }
    const model = await this.deps.prisma.aiModel.findUniqueOrThrow({
      where: { id: paid.modelId },
      select: { modelKey: true },
    });
    const id = staged.assetId;
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.asset.create({
        data: {
          id,
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          assetType: 'audio',
          sourceType: 'generated',
          generationJobId: paid.id,
          storyboardSceneId: input.sceneId,
          storageKey: staged.objectKey,
          mimeType: audio.mimeType,
          sizeBytes: BigInt(audio.sizeBytes),
          checksumSha256: audio.sha256Hex,
          durationMs: audio.durationMs,
          label: `Scene ${String(input.sceneNumber)} voice-over`,
          metadata: {
            purpose: 'voiceover',
            voiceoverHash: input.voiceoverHash,
            model: model.modelKey,
            voice: input.voice.voice,
            language: input.voice.language,
            ...(characters === null ? {} : { characters }),
            // M6 does not stretch narration silently: the scene is flagged for the user.
            exceedsScene: audio.durationMs > input.sceneDurationSeconds * 1000,
            audio: { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels },
          },
          createdById: job.requestedById,
        },
      });
      if (!(await this.deps.jobs.succeedSceneJobIn(tx, job, [id]))) throw new MediaDiscardedError();
    });
    return id;
  }

  /**
   * Runs the steps after a paid output was delivered. A failure there must not retry the job
   * (that would pay again): unexpected errors become final and finishable (P3d R3).
   */
  private async afterDelivery<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MediaPermanentError || error instanceof MediaDiscardedError) throw error;
      if (error instanceof StorageError && error.code === 'STORAGE_UNAVAILABLE') {
        throw new MediaPermanentError(
          'STORAGE_UNAVAILABLE',
          'storage failed after delivery; finish once it is back (no new charge)',
        );
      }
      this.deps.logger.log('error', 'after_delivery_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new MediaPermanentError(
        'INTERNAL_ERROR',
        'an internal error occurred after delivery; finish to retry (no new charge)',
      );
    }
  }
}

/** Storage write retries after a paid delivery (P3d R5): 1 s, 4 s, 16 s, ±20 % jitter. */
export const STORAGE_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

const VIDEO_CONTAINERS: Partial<Record<SniffedContainer, StoredMimeType>> = {
  iso: 'video/mp4',
  quicktime: 'video/quicktime',
  webm: 'video/webm',
};
const AUDIO_CONTAINERS: Partial<Record<SniffedContainer, StoredMimeType>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  adts: 'audio/aac',
  iso: 'audio/mp4',
};

/** The stored type of a delivered file, from its first bytes; null when it is not one we keep. */
export function stagedMimeType(kind: 'video' | 'audio', bytes: Uint8Array): StoredMimeType | null {
  const container = sniffContainer(bytes.subarray(0, 16));
  if (!container) return null;
  return (kind === 'video' ? VIDEO_CONTAINERS : AUDIO_CONTAINERS)[container] ?? null;
}

/** The stored delivery of a job, or null when nothing usable was stored. */
export function stagedOf(job: GenerationJob): StagedOutput | null {
  if (!job.stagedObjectKey || !job.stagedAssetId || !job.stagedSha256 || !job.stagedMimeType)
    return null;
  return {
    assetId: job.stagedAssetId,
    objectKey: job.stagedObjectKey,
    sha256Hex: job.stagedSha256,
    mimeType: job.stagedMimeType,
  };
}

/** Collects a download into memory, bounded like the clip download. */
async function readStream(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MediaPermanentError('OUTPUT_INVALID', 'clip larger than 200 MB');
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Reads a stored delivery and checks its checksum. */
async function readStaged(
  store: ObjectStore,
  staged: StagedOutput,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = await store.getBytes(staged.objectKey, maxBytes);
  if (!bytes) {
    throw new MediaPermanentError(
      'OUTPUT_NOT_STORED',
      'the delivered file is missing from storage',
    );
  }
  if (sha256Hex(bytes) !== staged.sha256Hex) {
    throw new MediaPermanentError('OUTPUT_INVALID', 'the stored file does not match its checksum');
  }
  return bytes;
}
