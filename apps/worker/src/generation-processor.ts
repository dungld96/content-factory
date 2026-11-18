import {
  isProviderError,
  type GenerationContext,
  type ImageReference,
  type LlmMessage,
  type LlmResult,
} from '@acf/ai-core';
import {
  ImageConstraintError,
  RoutingError,
  type ImageService,
  type LlmService,
} from '@acf/ai-runtime';
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
  buildImagePrompt,
  imageJobInputSchema,
  IMAGE_PROMPT_TEMPLATE_ID,
  toResponseJsonSchema,
  totalDuration,
  type DeadLetterPayload,
  type RuleIssue,
  type ScriptContent,
  type TextJobKind,
} from '@acf/content-domain';
import type { GenerationJob, Prisma, PrismaClient } from '@acf/database';
import { ZodError, type z } from 'zod';

import type { JobStore } from './job-store.js';
import type { Logger } from './logger.js';

export type ProcessOutcome =
  | { readonly type: 'succeeded'; readonly versionId: string }
  | { readonly type: 'retry'; readonly errorCode: string; readonly delayMs: number }
  | { readonly type: 'failed'; readonly errorCode: string }
  | { readonly type: 'discarded' }
  | { readonly type: 'skipped' };

export interface ProcessorDeps {
  readonly prisma: PrismaClient;
  readonly jobs: JobStore;
  readonly llm: LlmService;
  /** Image generation (M4); absent → image jobs fail with NO_ELIGIBLE_MODEL. */
  readonly images?: ImageService;
  /** Object storage for references and results (M4); null → STORAGE_NOT_CONFIGURED. */
  readonly store?: ObjectStore | null;
  /** Copies a finally failed job to the dead-letter queue (M3 Q8). */
  readonly deadLetter: (payload: DeadLetterPayload) => Promise<void>;
  readonly logger: Logger;
  readonly random?: () => number;
  /** Override of the retry delay (tests); defaults to `retryDelayMs` (RETRY_POLICY). */
  readonly retryDelay?: (attempt: number, retryAfterMs: number | undefined) => number;
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
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
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
  constructor(private readonly deps: ProcessorDeps) {}

  async process(jobId: string): Promise<ProcessOutcome> {
    const { jobs, logger } = this.deps;
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
      const versionId =
        job.kind === 'image_generation'
          ? await this.runImages(job)
          : job.kind === 'script_generation'
            ? await this.runScript(job)
            : await this.runStoryboard(job);
      logger.log('info', 'job_succeeded', { jobId, attempt: job.attempt, versionId });
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
    const prompt = renderPrompt(storyboardV1, {
      language: input.language,
      targetDurationSeconds: input.targetDurationSeconds,
      toleranceSeconds,
      aspectRatio: input.aspectRatio,
      script: scriptContent,
      characters,
      environments,
    });
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
            schema: jsonSchema,
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

  // ------------------------------------------------------------------- errors

  private async handleError(job: GenerationJob, error: unknown): Promise<ProcessOutcome> {
    const { jobs, logger } = this.deps;
    if (error instanceof DiscardedError) {
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
    if (error instanceof ImageConstraintError) {
      return this.failFinal(job, 'MODEL_LIMITS', error.message);
    }
    if (error instanceof PermanentJobError) {
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

  private async retry(
    job: GenerationJob,
    errorCode: string,
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
    errorCode: string,
    message: string,
    detail: Prisma.InputJsonObject = {},
  ): Promise<ProcessOutcome> {
    const changed = await this.deps.jobs.fail(job, errorCode, message, detail);
    if (!changed) return { type: 'skipped' };
    try {
      await this.deps.deadLetter({
        jobId: job.id,
        errorCode,
        attempt: job.attempt,
        failedAt: new Date().toISOString(),
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
