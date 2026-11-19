import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  VIDEO_POLL_LIMIT_MS,
  VIDEO_PROMPT_TEMPLATE_ID,
  videoJobInputSchema,
  videoPollDelayMs,
  type VideoJobInput,
} from '@acf/content-domain';
import type { GenerationJob, PrismaClient } from '@acf/database';
import {
  DEFAULT_MEDIA_TOOLS,
  inspectAudio,
  inspectVideoFile,
  MediaToolsMissingError,
  MediaValidationError,
  type MediaTools,
} from '@acf/media';
import { assetObjectKey, uuidv7, type ObjectStore } from '@acf/storage';

import type { JobStore } from './job-store.js';
import type { Logger } from './logger.js';

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
    readonly code: string,
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
  readonly logger: Logger;
  readonly now?: (() => Date) | undefined;
}

/** How the processor finishes a job (dead letter, content status) and handles other errors. */
export interface MediaOutcomes {
  readonly failFinal: (
    job: GenerationJob,
    code: string,
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
    const delayMs = videoPollDelayMs(0);
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
    const delayMs = videoPollDelayMs(job.pollCount + 1);
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
      const code = `PROVIDER_${state.status.toUpperCase()}`;
      const message = state.error ?? `the provider reported ${state.status}`;
      await this.deps.jobs.recordPoll(job, state, null);
      await videos.fail(invocationId, state, code, message);
      return this.outcomes.failFinal(job, code, message);
    }
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
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
        const delayMs = videoPollDelayMs(1);
        const pollCount = await this.deps.jobs.recordPoll(
          job,
          state,
          new Date(this.now().getTime() + delayMs),
        );
        if (pollCount === null) return { type: 'skipped' };
        await this.schedulePoll(job.id, pollCount, delayMs);
        return { type: 'polling', pollCount };
      }

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
          // Paid already: never resubmitted automatically; the user may regenerate.
          await this.deps.jobs.recordPoll(job, state, null);
          await videos.fail(invocationId, state, 'OUTPUT_INVALID', error.message);
          return await this.outcomes.failFinal(
            job,
            'OUTPUT_INVALID',
            `the clip failed validation: ${error.message}`,
          );
        }
        if (error instanceof MediaToolsMissingError) {
          throw new MediaPermanentError(
            'MEDIA_TOOLS_MISSING',
            'FFprobe is not installed on the worker',
          );
        }
        throw error;
      }
      const bytes = new Uint8Array(await readFile(file));
      const id = uuidv7();
      const storageKey = assetObjectKey({
        projectId: job.projectId,
        assetId: id,
        sha256Hex: clip.sha256Hex,
        mimeType: clip.mimeType,
      });
      await store.putIfAbsent(storageKey, bytes, {
        contentType: clip.mimeType,
        sha256Hex: clip.sha256Hex,
      });
      const request = await this.request(job, input);
      await videos.complete(invocationId, request, state);
      const model = await this.deps.prisma.aiModel.findUniqueOrThrow({
        where: { id: job.modelId },
        select: { modelKey: true },
      });
      await this.deps.prisma.$transaction(async (tx) => {
        await tx.asset.create({
          data: {
            id,
            projectId: job.projectId,
            contentItemId: job.contentItemId,
            assetType: 'video',
            sourceType: 'generated',
            generationJobId: job.id,
            storyboardSceneId: input.sceneId,
            storageKey,
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
        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            providerStatus: state.status,
            pollCount: job.pollCount + 1,
            lastPolledAt: this.now(),
            nextPollAt: null,
          },
        });
        if (!(await this.deps.jobs.succeedSceneJobIn(tx, job, [id])))
          throw new MediaDiscardedError();
      });
      this.deps.logger.log('info', 'video_completed', { jobId: job.id, assetId: id });
      return { type: 'succeeded', versionId: id };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------- TTS

  /** One voice-over: synthesize, validate with FFprobe, store, succeed (M5 design §7.2). */
  async runTts(job: GenerationJob): Promise<string> {
    const tts = this.deps.tts;
    if (!tts) throw new MediaPermanentError('NO_ELIGIBLE_MODEL', 'no TTS providers are configured');
    const store = this.deps.store;
    if (!store)
      throw new MediaPermanentError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    const input = ttsJobInputSchema.parse(job.input);
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
    let audio;
    try {
      audio = await inspectAudio(result.bytes, result.mimeType, {
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
          'FFprobe is not installed on the worker',
        );
      throw error;
    }
    const id = uuidv7();
    const storageKey = assetObjectKey({
      projectId: job.projectId,
      assetId: id,
      sha256Hex: audio.sha256Hex,
      mimeType: audio.mimeType,
    });
    await store.putIfAbsent(storageKey, result.bytes, {
      contentType: audio.mimeType,
      sha256Hex: audio.sha256Hex,
    });
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.asset.create({
        data: {
          id,
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          assetType: 'audio',
          sourceType: 'generated',
          generationJobId: job.id,
          storyboardSceneId: input.sceneId,
          storageKey,
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
            characters: result.characters,
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
}
