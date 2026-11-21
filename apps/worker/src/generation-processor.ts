import {
  isProviderError,
  ProviderErrorOutcome,
  type GenerationContext,
  type ImageReference,
  type LlmMessage,
  type LlmResult,
} from '@acf/ai-core';
import {
  ImageConstraintError,
  MediaConstraintError,
  recheckJobBudget,
  RoutingError,
  type CircuitBreaker,
  type ImageService,
  type LlmService,
  type TtsService,
  type VideoService,
} from '@acf/ai-runtime';
import type { MediaTools } from '@acf/media';
import {
  assetObjectKey,
  ImageValidationError,
  inspectImage,
  StorageError,
  uuidv7,
  type InspectedImage,
  type ObjectStore,
} from '@acf/storage';
import {
  durationTolerance,
  formatIssues,
  MAX_OUTPUT_TOKENS,
  parseModelOutput,
  PromptVariablesError,
  renderPrompt,
  repairV1,
  retryDelayMs,
  SCRIPT_SCHEMA_VERSION,
  scriptContentSchema,
  scriptJobInputSchema,
  scriptRuleIssues,
  scriptV1,
  STORYBOARD_SCHEMA_VERSION,
  storyboardContentSchema,
  storyboardJobInputSchema,
  storyboardRuleIssues,
  storyboardV1,
  storyboardV2,
  narrationWordsPerSecond,
  basicJsonSchema,
  buildImagePrompt,
  imageJobInputSchema,
  IMAGE_PROMPT_TEMPLATE_ID,
  toResponseJsonSchema,
  totalDuration,
  type DeadLetterPayload,
  type JobErrorCode,
  type RuleIssue,
  type ScriptContent,
  type TextJobKind,
  VIDEO_POLL_JOB_NAME,
  videoPollDelayMs,
} from '@acf/content-domain';
import type { GenerationJob, Prisma, PrismaClient } from '@acf/database';
import { ZodError, type z } from 'zod';

import type { JobStore } from './job-store.js';
import type { Logger } from './logger.js';
import type { MediaToolsGate } from './media-tools-gate.js';
import {
  MediaDiscardedError,
  MediaJobs,
  MediaPermanentError,
  type MediaStepOutcome,
} from './media-jobs.js';
import { RenderJobs } from './render-jobs.js';

export type ProcessOutcome =
  | { readonly type: 'succeeded'; readonly versionId: string }
  | { readonly type: 'retry'; readonly errorCode: string; readonly delayMs: number }
  | { readonly type: 'failed'; readonly errorCode: string }
  | { readonly type: 'discarded' }
  | { readonly type: 'skipped' }
  /** A video job was accepted by the provider; polls follow as separate BullMQ jobs (M5). */
  | { readonly type: 'submitted'; readonly providerJobId: string }
  | { readonly type: 'polling'; readonly pollCount: number }
  /**
   * The provider's circuit is open (M7 design §7): delivered again after `delayMs` without using
   * an attempt (PostgreSQL or BullMQ).
   */
  | { readonly type: 'deferred'; readonly errorCode: string; readonly delayMs: number };

export interface ProcessorDeps {
  readonly prisma: PrismaClient;
  readonly jobs: JobStore;
  readonly llm: LlmService;
  /** Image generation (M4); absent → image jobs fail with NO_ELIGIBLE_MODEL. */
  readonly images?: ImageService;
  /** Object storage for references and results (M4); null → STORAGE_NOT_CONFIGURED. */
  readonly store?: ObjectStore | null;
  /** Video generation (M5); absent → video jobs fail with NO_ELIGIBLE_MODEL. */
  readonly videos?: VideoService;
  /** Text-to-speech (M5); absent → TTS jobs fail with NO_ELIGIBLE_MODEL. */
  readonly tts?: TtsService;
  /** Adds poll number `pollCount` of a video job to the video queue after `delayMs`. */
  readonly schedulePoll?: (jobId: string, pollCount: number, delayMs: number) => Promise<void>;
  /** FFprobe/FFmpeg locations (M5a). */
  readonly mediaTools?: MediaTools;
  /** FFmpeg/FFprobe check before paid media calls (P3d R6); the worker always passes one. */
  readonly mediaToolsGate?: MediaToolsGate;
  /** Storage retries after a paid delivery (P3d R5); default 1 s, 4 s, 16 s. */
  readonly storageRetryDelaysMs?: readonly number[];
  /** Ceiling per FFmpeg step of a render (M6, `RENDER_TIMEOUT_MS`). */
  readonly renderStepTimeoutMs?: number;
  /** Factor applied to the video poll schedule (tests and E2E). */
  readonly videoPollScale?: number;
  /** Copies a finally failed job to the dead-letter queue (M3 Q8). */
  readonly deadLetter: (payload: DeadLetterPayload) => Promise<void>;
  readonly logger: Logger;
  readonly random?: () => number;
  /** Override of the retry delay (tests); defaults to `retryDelayMs` (RETRY_POLICY). */
  readonly retryDelay?: (attempt: number, retryAfterMs: number | undefined) => number;
  /** Circuit breaker per provider (M7b); absent → calls are never held back. */
  readonly circuits?: CircuitBreaker;
}

/** The model output stayed invalid after deterministic and one LLM repair (decision Q5). */
class OutputInvalidError extends Error {
  constructor(readonly issues: readonly RuleIssue[]) {
    super('model output invalid after repair');
  }
}
/** The job was canceled while its LLM call ran: discard the result (M3 design §8.5). */
class DiscardedError extends Error {}
/** A job that cannot succeed as configured (no storage, missing reference file): never retried. */
class PermanentJobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
  }
}
/**
 * Job kinds whose synchronous provider call ends the job when its outcome is unknown (P3 W5):
 * OpenRouter does not document whether such text or speech calls are billed.
 */
const HOLD_ON_UNKNOWN: ReadonlySet<string> = new Set([
  'script_generation',
  'storyboard_generation',
  'tts_generation',
]);

/** The provider returned bytes that are not a valid image of the declared type (retryable). */
class ImageOutputError extends Error {}

/** Largest reference image loaded into memory for a call (M4 design §3.1). */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

interface Structured<T> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly rules: (value: T) => readonly RuleIssue[];
}

/**
 * Runs one attempt of a generation job (M3 design §8.1). PostgreSQL is authoritative: every
 * decision is recorded there; BullMQ only redelivers.
 */
export class GenerationProcessor {
  private readonly media: MediaJobs;
  private readonly renders: RenderJobs;

  constructor(private readonly deps: ProcessorDeps) {
    this.media = new MediaJobs(
      {
        prisma: deps.prisma,
        jobs: deps.jobs,
        store: deps.store ?? null,
        videos: deps.videos,
        tts: deps.tts,
        schedulePoll: deps.schedulePoll,
        tools: deps.mediaTools,
        toolsGate: deps.mediaToolsGate,
        storageRetryDelaysMs: deps.storageRetryDelaysMs,
        pollScale: deps.videoPollScale,
        logger: deps.logger,
      },
      { failFinal: (job, code, message) => this.failFinal(job, code, message) },
    );
    this.renders = new RenderJobs({
      prisma: deps.prisma,
      jobs: deps.jobs,
      store: deps.store ?? null,
      tools: deps.mediaTools,
      stepTimeoutMs: deps.renderStepTimeoutMs,
      logger: deps.logger,
    });
  }

  /**
   * Runs the BullMQ job `name` of generation job `jobId`: `generate` (an attempt) or, for video
   * jobs, `poll` (one status read, M5 design §5.2).
   */
  async process(jobId: string, name = 'generate'): Promise<ProcessOutcome> {
    const { jobs, logger } = this.deps;
    if (name === VIDEO_POLL_JOB_NAME) return this.poll(jobId);
    const current = await jobs.load(jobId);
    if (
      current?.kind === 'video_generation' &&
      current.status === 'running' &&
      current.submittedAt
    ) {
      // Delivered again after the submit started (worker restart, reconciler): never resubmit.
      try {
        return stepOutcome(await this.media.resumeVideo(current));
      } catch (error) {
        return this.handleError(current, error);
      }
    }
    if (current?.status === 'queued') {
      const wait = await this.waitForCircuit(current);
      if (wait) return wait;
    }
    const job = await jobs.startAttempt(jobId);
    if (!job) {
      const current = await jobs.load(jobId);
      if (current?.status === 'running' && current.attempt >= current.maxAttempts) {
        // Redelivered after the last attempt's worker died: nothing left to try.
        return this.failFinal(current, 'WORKER_LOST', 'the worker stopped during the last attempt');
      }
      return { type: 'skipped' };
    }
    logger.log('info', 'job_attempt_started', { jobId, kind: job.kind, attempt: job.attempt });
    try {
      const breach = await this.recheckBudget(job);
      if (breach) {
        return await this.failFinal(job, 'BUDGET_EXCEEDED', breach.message, breach.detail);
      }
      if (job.kind === 'video_generation') {
        const step = stepOutcome(await this.media.submitVideo(job));
        await this.circuitSuccess(job);
        return step;
      }
      const versionId =
        job.kind === 'image_generation'
          ? await this.runImages(job)
          : job.kind === 'tts_generation'
            ? await this.media.runTts(job)
            : job.kind === 'render'
              ? await this.renders.run(job)
              : job.kind === 'script_generation'
                ? await this.runScript(job)
                : await this.runStoryboard(job);
      logger.log('info', 'job_succeeded', { jobId, attempt: job.attempt, versionId });
      await this.circuitSuccess(job);
      return { type: 'succeeded', versionId };
    } catch (error) {
      return this.handleError(job, error);
    }
  }

  // ------------------------------------------------------------------- script

  private async runScript(job: GenerationJob): Promise<string> {
    const { prisma } = this.deps;
    const input = scriptJobInputSchema.parse(job.input);
    const [character, environment] = await Promise.all([
      input.characterVersionId ? this.brandRef('character', input.characterVersionId) : null,
      input.environmentVersionId ? this.brandRef('environment', input.environmentVersionId) : null,
    ]);
    const prompt = renderPrompt(scriptV1, {
      language: input.language,
      targetDurationSeconds: input.targetDurationSeconds,
      aspectRatio: input.aspectRatio,
      brief: input.brief,
      claimFlags: input.claimFlags,
      character,
      environment,
    });
    const content = await this.generate<ScriptContent>(
      job,
      prompt.snapshot,
      prompt.messages,
      input.qualityTier,
      {
        name: 'script_content',
        schema: scriptContentSchema,
        rules: (v) => scriptRuleIssues(v, { allowedSourceUrls: input.brief.sourceUrls }),
      },
    );

    return prisma.$transaction(async (tx) => {
      const version = await nextVersion(tx, 'script_versions', job.contentItemId);
      const row = await tx.scriptVersion.create({
        data: {
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          version,
          source: 'generated',
          generationJobId: job.id,
          schemaVersion: SCRIPT_SCHEMA_VERSION,
          content: content,
        },
        select: { id: true },
      });
      if (
        !(await this.deps.jobs.succeedIn(
          tx,
          job,
          { scriptVersionId: row.id },
          { type: 'script_created' },
        ))
      ) {
        throw new DiscardedError();
      }
      return row.id;
    });
  }

  // ------------------------------------------------------------------- storyboard

  private async runStoryboard(job: GenerationJob): Promise<string> {
    const { prisma } = this.deps;
    const input = storyboardJobInputSchema.parse(job.input);
    const script = await prisma.scriptVersion.findFirstOrThrow({
      where: { id: input.scriptVersionId, contentItemId: job.contentItemId },
      select: { content: true },
    });
    const scriptContent = scriptContentSchema.parse(script.content);
    const characters = await Promise.all(
      input.characterVersionIds.map((id) => this.offered('character', id)),
    );
    const environments = await Promise.all(
      input.environmentVersionIds.map((id) => this.offered('environment', id)),
    );
    const toleranceSeconds = durationTolerance(input.targetDurationSeconds);
    const variables = {
      language: input.language,
      targetDurationSeconds: input.targetDurationSeconds,
      toleranceSeconds,
      aspectRatio: input.aspectRatio,
      script: scriptContent,
      characters,
      environments,
    };
    // The job records its template: jobs queued before M8.5 replay storyboard.v1 exactly.
    const prompt =
      job.promptTemplateId === storyboardV2.id
        ? renderPrompt(storyboardV2, {
            ...variables,
            clipDurations: input.clipDurations ?? null,
            wordsPerSecond: input.wordsPerSecond ?? narrationWordsPerSecond(input.language, 1),
          })
        : renderPrompt(storyboardV1, variables);
    const allowedAssetIds = [...characters, ...environments].flatMap((v) => v.referenceAssetIds);
    const content = await this.generate(job, prompt.snapshot, prompt.messages, input.qualityTier, {
      name: 'storyboard_content',
      schema: storyboardContentSchema,
      rules: (v) =>
        storyboardRuleIssues(v, {
          targetDurationSeconds: input.targetDurationSeconds,
          allowedCharacterVersionIds: input.characterVersionIds,
          allowedEnvironmentVersionIds: input.environmentVersionIds,
          allowedAssetIds,
          allowedSceneDurations: input.clipDurations ?? null,
        }),
    });

    return prisma.$transaction(async (tx) => {
      const version = await nextVersion(tx, 'storyboard_versions', job.contentItemId);
      const row = await tx.storyboardVersion.create({
        data: {
          projectId: job.projectId,
          contentItemId: job.contentItemId,
          scriptVersionId: input.scriptVersionId,
          version,
          source: 'generated',
          generationJobId: job.id,
          schemaVersion: STORYBOARD_SCHEMA_VERSION,
          totalDurationSeconds: totalDuration(content).toFixed(2),
        },
        select: { id: true },
      });
      for (const scene of content.scenes) {
        const created = await tx.storyboardScene.create({
          data: {
            projectId: job.projectId,
            storyboardVersionId: row.id,
            sceneNumber: scene.sceneNumber,
            durationSeconds: scene.durationSeconds.toFixed(2),
            shotType: scene.shotType,
            cameraAngle: scene.cameraAngle,
            cameraMovement: scene.cameraMovement,
            characterAction: scene.characterAction,
            characterVersionId: scene.characterVersionId,
            environmentVersionId: scene.environmentVersionId,
            visualDescription: scene.visualDescription,
            imagePrompt: scene.imagePrompt,
            videoPrompt: scene.videoPrompt,
            negativePrompt: scene.negativePrompt,
            voiceOverSegment: scene.voiceOverSegment,
            onScreenText: scene.onScreenText,
            acceptanceChecks: scene.acceptanceChecks,
          },
          select: { id: true },
        });
        const assetIds = [...new Set(scene.requiredReferenceAssetIds)];
        if (assetIds.length > 0) {
          await tx.storyboardSceneAsset.createMany({
            data: assetIds.map((assetId) => ({
              projectId: job.projectId,
              sceneId: created.id,
              assetId,
            })),
          });
        }
      }
      if (
        !(await this.deps.jobs.succeedIn(
          tx,
          job,
          { storyboardVersionId: row.id },
          { type: 'storyboard_created' },
        ))
      ) {
        throw new DiscardedError();
      }
      return row.id;
    });
  }

  // ------------------------------------------------------------------- LLM + repair ladder

  /** First call; on invalid output exactly one repair call; then OUTPUT_INVALID (Q5). */
  private async generate<T>(
    job: GenerationJob,
    snapshot: string,
    messages: LlmMessage[],
    qualityTier: GenerationContext['qualityTier'],
    structured: Structured<T>,
  ): Promise<T> {
    await this.deps.jobs.recordPrompt(job.id, snapshot);
    const model = await this.deps.prisma.aiModel.findUniqueOrThrow({
      where: { id: job.modelId },
      include: { provider: true },
    });
    const jsonSchema = toResponseJsonSchema(structured.schema);
    // `basic` models get the structure only (M8.5 Q2); validation and repair use the full schema.
    const requestSchema = model.schemaMode === 'basic' ? basicJsonSchema(jsonSchema) : jsonSchema;
    const context: GenerationContext = {
      projectId: job.projectId,
      contentItemId: job.contentItemId,
      generationJobId: job.id,
      correlationId: job.id,
      qualityTier,
    };
    const call = (msgs: LlmMessage[], n: number): Promise<LlmResult> =>
      this.deps.llm.complete(
        context,
        {
          modelKey: model.modelKey,
          messages: msgs,
          // Text jobs only reach this path (image jobs have their own processor, M4c).
          maxOutputTokens: MAX_OUTPUT_TOKENS[job.kind as TextJobKind],
          responseFormat: {
            type: 'json_schema',
            name: structured.name,
            schema: requestSchema,
            strict: true,
          },
        },
        {
          providerKey: model.provider.key,
          idempotencyKey: `${job.id}:${String(job.attempt)}:${String(n)}`,
        },
      );

    const first = await call(messages, 1);
    const parsed = parseModelOutput(first.text, structured.schema, structured.rules);
    if (parsed.ok) return parsed.value;

    this.deps.logger.log('warn', 'job_output_repair', {
      jobId: job.id,
      attempt: job.attempt,
      stage: parsed.stage,
      issues: parsed.issues.length,
    });
    const repair = renderPrompt(repairV1, {
      schemaName: structured.name,
      jsonSchema,
      issues: formatIssues(parsed.issues),
      invalidJson: (parsed.json ?? first.text).slice(0, 50_000),
    });
    const second = await call(repair.messages, 2);
    const repaired = parseModelOutput(second.text, structured.schema, structured.rules);
    if (repaired.ok) return repaired.value;
    throw new OutputInvalidError(repaired.issues);
  }

  private async brandRef(kind: 'character' | 'environment', versionId: string) {
    const v = await this.version(kind, versionId);
    return { name: v.name, description: v.description };
  }

  private async offered(kind: 'character' | 'environment', versionId: string) {
    const v = await this.version(kind, versionId);
    return {
      versionId,
      name: v.name,
      description: v.description,
      rules: v.rules,
      referenceAssetIds: v.assetIds,
    };
  }

  /** Approved master versions are immutable, so reading them at run time is deterministic. */
  private async version(kind: 'character' | 'environment', id: string) {
    const { prisma } = this.deps;
    if (kind === 'character') {
      const v = await prisma.characterVersion.findUniqueOrThrow({
        where: { id },
        include: { character: true, assets: true },
      });
      return {
        name: v.character.name,
        description: v.description,
        rules: v.identityRules,
        assetIds: [
          ...new Set(
            [v.primaryAssetId, ...v.assets.map((l) => l.assetId)].filter(
              (x): x is string => x !== null,
            ),
          ),
        ],
      };
    }
    const v = await prisma.environmentVersion.findUniqueOrThrow({
      where: { id },
      include: { environment: true, assets: true },
    });
    return {
      name: v.environment.name,
      description: v.description,
      rules: v.visualRules,
      assetIds: [
        ...new Set(
          [v.primaryAssetId, ...v.assets.map((l) => l.assetId)].filter(
            (x): x is string => x !== null,
          ),
        ),
      ],
    };
  }

  // ------------------------------------------------------------------- images (M4)

  /**
   * One image job = one scene (M4 design §5.3): load references from storage, call the image
   * model (split into calls of the model's `n` maximum), validate every image, store it
   * write-once, then insert the assets and their lineage and succeed in one transaction.
   * Returns the first new asset id.
   */
  private async runImages(job: GenerationJob): Promise<string> {
    const { prisma, jobs } = this.deps;
    const input = imageJobInputSchema.parse(job.input);
    const store = this.deps.store;
    if (!store) {
      throw new PermanentJobError('STORAGE_NOT_CONFIGURED', 'object storage is not configured');
    }
    if (!this.deps.images) {
      throw new PermanentJobError('NO_ELIGIBLE_MODEL', 'no image providers are configured');
    }
    const prompt = buildImagePrompt({
      scene: input.scene,
      characterName: input.characterName,
      environmentName: input.environmentName,
      aspectRatio: input.aspectRatio,
      hasReferences: input.references.length > 0,
    });
    await jobs.recordPrompt(job.id, `### ${IMAGE_PROMPT_TEMPLATE_ID}\n${prompt}`);

    const rows = await prisma.asset.findMany({
      where: { projectId: job.projectId, id: { in: input.references.map((r) => r.assetId) } },
      select: { id: true, storageKey: true, mimeType: true },
    });
    const references: ImageReference[] = [];
    for (const ref of input.references) {
      const row = rows.find((r) => r.id === ref.assetId);
      const bytes = row ? await store.getBytes(row.storageKey, MAX_REFERENCE_BYTES) : null;
      if (!row || !bytes) {
        throw new PermanentJobError(
          'REFERENCE_MISSING',
          `reference asset ${ref.assetId} has no stored file`,
        );
      }
      references.push({ mimeType: row.mimeType as ImageReference['mimeType'], bytes });
    }

    const model = await prisma.aiModel.findUniqueOrThrow({
      where: { id: job.modelId },
      select: { modelKey: true, imageConstraints: true },
    });
    const perCall = Math.max(1, maxImagesOf(model.imageConstraints));
    const context: GenerationContext = {
      projectId: job.projectId,
      contentItemId: job.contentItemId,
      generationJobId: job.id,
      correlationId: job.id,
      qualityTier: input.qualityTier,
    };
    const images: InspectedImage[] = [];
    const bytesOf = new Map<InspectedImage, Uint8Array>();
    for (let call = 0, remaining = input.count; remaining > 0; call++) {
      const count = Math.min(perCall, remaining);
      remaining -= count;
      const { result } = await this.deps.images.generate(
        context,
        {
          modelKey: model.modelKey,
          prompt,
          aspectRatio: input.aspectRatio,
          ...(input.resolution ? { resolution: input.resolution } : {}),
          count,
          ...(input.seed === null ? {} : { seed: input.seed + call }),
          references,
          ...(input.zeroDataRetention ? { dataPolicy: { zeroDataRetention: true } } : {}),
        },
        { idempotencyKey: `${job.id}:${String(job.attempt)}:${String(call)}` },
      );
      for (const image of result.images) {
        let inspected: InspectedImage;
        try {
          inspected = inspectImage(image.bytes, image.declaredType);
        } catch (error) {
          if (error instanceof ImageValidationError) throw new ImageOutputError(error.code);
          throw error;
        }
        images.push(inspected);
        bytesOf.set(inspected, image.bytes);
      }
    }
    if (images.length === 0) throw new ImageOutputError('no images returned');

    // Bytes first (write-once, content-addressed), rows second: a failed transaction leaves only
    // private orphan objects (M4 design §4.2).
    const planned = images.map((image) => ({ image, id: uuidv7() }));
    for (const { image, id } of planned) {
      await store.putIfAbsent(
        assetObjectKey({
          projectId: job.projectId,
          assetId: id,
          sha256Hex: image.sha256Hex,
          mimeType: image.mimeType,
        }),
        bytesOf.get(image) ?? new Uint8Array(),
        { contentType: image.mimeType, sha256Hex: image.sha256Hex },
      );
    }
    return prisma.$transaction(async (tx) => {
      for (const { image, id } of planned) {
        await tx.asset.create({
          data: {
            id,
            projectId: job.projectId,
            contentItemId: job.contentItemId,
            assetType: 'image',
            sourceType: 'generated',
            generationJobId: job.id,
            storyboardSceneId: input.sceneId,
            storageKey: assetObjectKey({
              projectId: job.projectId,
              assetId: id,
              sha256Hex: image.sha256Hex,
              mimeType: image.mimeType,
            }),
            mimeType: image.mimeType,
            sizeBytes: BigInt(image.sizeBytes),
            checksumSha256: image.sha256Hex,
            width: image.width,
            height: image.height,
            label: `Scene ${String(input.scene.sceneNumber)}`,
            metadata: { sceneHash: input.sceneHash, model: model.modelKey },
            createdById: job.requestedById,
          },
        });
        if (input.references.length > 0) {
          await tx.assetInput.createMany({
            data: input.references.map((r) => ({
              projectId: job.projectId,
              assetId: id,
              inputAssetId: r.assetId,
              role: r.role,
            })),
          });
        }
      }
      const ids = planned.map((p) => p.id);
      if (!(await jobs.succeedImageIn(tx, job, ids))) throw new DiscardedError();
      return ids[0] ?? '';
    });
  }

  // ------------------------------------------------------------------- video polls (M5)

  /**
   * One status read of a running video job. A poll is never retried by BullMQ: on an unexpected
   * error (database, storage) the next poll is scheduled here, or by the reconciler if even that
   * fails. Polls do not count as attempts: the provider job was submitted once.
   */
  private async poll(jobId: string): Promise<ProcessOutcome> {
    try {
      return stepOutcome(await this.media.pollVideo(jobId));
    } catch (error) {
      const job = await this.deps.jobs.load(jobId);
      if (!job || job.status !== 'running') return { type: 'skipped' };
      if (error instanceof MediaDiscardedError) return this.handleError(job, error);
      if (error instanceof MediaPermanentError) {
        if (job.invocationId && this.deps.videos) {
          await this.deps.videos
            .abandon(job.invocationId, error.code, error.message)
            .catch(() => undefined);
        }
        return this.failFinal(job, error.code, error.message);
      }
      this.deps.logger.log('error', 'video_poll_error', {
        jobId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      const delayMs = Math.round(
        videoPollDelayMs(job.pollCount + 1) * (this.deps.videoPollScale ?? 1),
      );
      const pollCount = await this.deps.jobs.recordPoll(job, null, new Date(Date.now() + delayMs));
      if (pollCount === null || !this.deps.schedulePoll) return { type: 'skipped' };
      await this.deps.schedulePoll(jobId, pollCount, delayMs);
      return { type: 'polling', pollCount };
    }
  }

  // ------------------------------------------------------------------- errors

  private async handleError(job: GenerationJob, error: unknown): Promise<ProcessOutcome> {
    const { jobs, logger } = this.deps;
    if (error instanceof DiscardedError || error instanceof MediaDiscardedError) {
      await jobs.noteDiscarded(job);
      logger.log('info', 'job_result_discarded', { jobId: job.id, attempt: job.attempt });
      return { type: 'discarded' };
    }
    if (error instanceof OutputInvalidError) {
      return this.failFinal(
        job,
        'OUTPUT_INVALID',
        'model output did not match the schema after one repair',
        {
          issues: formatIssues(error.issues.map((i) => ({ path: i.path, message: 'invalid' }))),
        },
      );
    }
    if (error instanceof RoutingError) {
      return this.failFinal(job, 'NO_ELIGIBLE_MODEL', error.message);
    }
    if (error instanceof ImageConstraintError || error instanceof MediaConstraintError) {
      return this.failFinal(job, 'MODEL_LIMITS', error.message);
    }
    if (error instanceof PermanentJobError || error instanceof MediaPermanentError) {
      return this.failFinal(job, error.code, error.message);
    }
    if (error instanceof ImageOutputError) {
      // A broken image may not repeat: retry within the attempt budget (cost per attempt).
      if (job.attempt < job.maxAttempts) return this.retry(job, 'OUTPUT_INVALID', undefined);
      return this.failFinal(
        job,
        'OUTPUT_INVALID',
        `invalid image from the provider (${error.message})`,
      );
    }
    if (error instanceof StorageError && error.code !== 'STORAGE_UNAVAILABLE') {
      return this.failFinal(job, error.code, error.message);
    }
    if (error instanceof ZodError || error instanceof PromptVariablesError) {
      return this.failFinal(job, 'INVALID_JOB_INPUT', 'the job input does not match its schema');
    }
    if (isProviderError(error)) {
      await this.circuitFailure(job, error.code);
      // P3 W5: a text or TTS call that may have reached the provider (timeout, lost connection
      // after sending) may have been charged; it is never sent again without the user's consent.
      // Images retry: their billing is documented as all-or-nothing (W6).
      if (error.outcome === ProviderErrorOutcome.UNKNOWN && HOLD_ON_UNKNOWN.has(job.kind)) {
        return this.failFinal(
          job,
          'CALL_OUTCOME_UNKNOWN',
          'the provider call could not be confirmed; resuming may be charged twice',
        );
      }
      if (error.retryable && job.attempt < job.maxAttempts) {
        return this.retry(job, error.code, error.retryAfterMs);
      }
      return this.failFinal(job, error.code, error.message);
    }
    // Infrastructure or unexpected error: retry while attempts remain (bounded).
    logger.log('error', 'job_attempt_error', {
      jobId: job.id,
      attempt: job.attempt,
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (job.attempt < job.maxAttempts) return this.retry(job, 'INTERNAL_ERROR', undefined);
    return this.failFinal(job, 'INTERNAL_ERROR', 'internal error');
  }

  // ------------------------------------------------------------------- circuit breaker

  /** The provider a job's calls go to, or null for local work (renders) and unknown models. */
  private async providerOf(job: GenerationJob): Promise<string | null> {
    if (!this.deps.circuits || job.kind === 'render') return null;
    const model = await this.deps.prisma.aiModel.findUnique({
      where: { id: job.modelId },
      select: { providerId: true },
    });
    return model?.providerId ?? null;
  }

  /**
   * Before an attempt starts: an open circuit defers the job (no attempt used). A job that has
   * waited longer than the circuit policy's `maxWaitMs` (2 h) since it was queued fails with
   * `PROVIDER_UNAVAILABLE`.
   */
  private async waitForCircuit(job: GenerationJob): Promise<ProcessOutcome | null> {
    const providerId = await this.providerOf(job);
    if (!providerId || !this.deps.circuits) return null;
    const admission = await this.deps.circuits.admit(providerId, job.id);
    if (admission.admitted) return null;
    if (Date.now() - job.queuedAt.getTime() > this.deps.circuits.policy.maxWaitMs) {
      return this.failFinal(
        job,
        'PROVIDER_UNAVAILABLE',
        'the provider stayed unavailable (circuit open) for too long',
      );
    }
    this.deps.logger.log('info', 'job_deferred_circuit_open', {
      jobId: job.id,
      delayMs: admission.retryInMs,
    });
    return { type: 'deferred', errorCode: 'PROVIDER_CIRCUIT_OPEN', delayMs: admission.retryInMs };
  }

  private async circuitSuccess(job: GenerationJob): Promise<void> {
    const providerId = await this.providerOf(job);
    if (providerId) await this.deps.circuits?.recordSuccess(providerId, job.id);
  }

  private async circuitFailure(job: GenerationJob, errorCode: string): Promise<void> {
    const providerId = await this.providerOf(job);
    if (providerId) await this.deps.circuits?.recordFailure(providerId, job.id, errorCode);
  }

  /**
   * The budget re-check right before the paid call (M7 design §5.2): if the budget was lowered
   * after the job was queued and its reservation no longer fits a hard limit, the job fails with
   * `BUDGET_EXCEEDED` (never retried; the reservation is released). Recorded as a `blocked`
   * budget event.
   */
  private async recheckBudget(
    job: GenerationJob,
  ): Promise<{ message: string; detail: Prisma.InputJsonObject } | null> {
    const found = await this.deps.prisma.$transaction(async (tx) => {
      const breach = await recheckJobBudget(tx, job);
      if (!breach) return null;
      const detail = {
        jobId: job.id,
        scope: breach.scope,
        mode: breach.mode,
        limitUsd: breach.limit.toString(),
        spentUsd: breach.spent.toString(),
        requestedUsd: breach.requested.toString(),
      };
      await tx.budgetEvent.create({ data: { projectId: job.projectId, type: 'blocked', detail } });
      return detail;
    });
    if (!found) return null;
    this.deps.logger.log('warn', 'budget_exceeded', { projectId: job.projectId, ...found });
    return {
      message: `the ${found.scope} budget of USD ${found.limitUsd} no longer covers this job (USD ${found.requestedUsd})`,
      detail: { budget: found },
    };
  }

  private async retry(
    job: GenerationJob,
    errorCode: JobErrorCode,
    retryAfterMs: number | undefined,
  ): Promise<ProcessOutcome> {
    const delayMs = this.deps.retryDelay
      ? this.deps.retryDelay(job.attempt, retryAfterMs)
      : retryDelayMs(job.attempt, retryAfterMs, this.deps.random);
    await this.deps.jobs.scheduleRetry(job, errorCode, delayMs);
    this.deps.logger.log('warn', 'job_retry_scheduled', {
      jobId: job.id,
      attempt: job.attempt,
      errorCode,
      delayMs,
    });
    return { type: 'retry', errorCode, delayMs };
  }

  private async failFinal(
    job: GenerationJob,
    errorCode: JobErrorCode,
    message: string,
    detail: Prisma.InputJsonObject = {},
  ): Promise<{ type: 'failed'; errorCode: string } | { type: 'skipped' }> {
    const changed = await this.deps.jobs.fail(job, errorCode, message, detail);
    if (!changed) return { type: 'skipped' };
    try {
      await this.deps.deadLetter({
        jobId: job.id,
        errorCode,
        attempt: job.attempt,
        failedAt: new Date().toISOString(),
      });
      this.deps.logger.log('error', 'job_dead_lettered', {
        jobId: job.id,
        projectId: job.projectId,
        kind: job.kind,
        errorCode,
      });
    } catch (error) {
      // PostgreSQL already holds the failure; the DLQ copy is for operators only.
      this.deps.logger.log('error', 'dead_letter_failed', {
        jobId: job.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    this.deps.logger.log('error', 'job_failed', { jobId: job.id, attempt: job.attempt, errorCode });
    return { type: 'failed', errorCode };
  }
}

const stepOutcome = (step: MediaStepOutcome): ProcessOutcome => step;

/** Next version number under a parent lock (same order as M1 edits: content item first). */
async function nextVersion(
  tx: Prisma.TransactionClient,
  table: 'script_versions' | 'storyboard_versions',
  contentItemId: string,
): Promise<number> {
  await tx.$queryRaw`SELECT 1 FROM content_items WHERE id = ${contentItemId}::uuid FOR NO KEY UPDATE`;
  const rows =
    table === 'script_versions'
      ? await tx.$queryRaw<
          { max: number | null }[]
        >`SELECT max(version)::int AS max FROM script_versions WHERE content_item_id = ${contentItemId}::uuid`
      : await tx.$queryRaw<
          { max: number | null }[]
        >`SELECT max(version)::int AS max FROM storyboard_versions WHERE content_item_id = ${contentItemId}::uuid`;
  return (rows[0]?.max ?? 0) + 1;
}

/** `ai_models.image_constraints.maxImages`, or 1 when not recorded. */
function maxImagesOf(constraints: unknown): number {
  if (typeof constraints === 'object' && constraints !== null && 'maxImages' in constraints) {
    const value = constraints.maxImages;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return 1;
}
