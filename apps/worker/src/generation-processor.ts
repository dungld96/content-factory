import {
  isProviderError,
  type GenerationContext,
  type LlmMessage,
  type LlmResult,
} from '@acf/ai-core';
import { RoutingError, type LlmService } from '@acf/ai-runtime';
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
  toResponseJsonSchema,
  totalDuration,
  type DeadLetterPayload,
  type RuleIssue,
  type ScriptContent,
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
        job.kind === 'script_generation'
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
          maxOutputTokens: MAX_OUTPUT_TOKENS[job.kind],
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
