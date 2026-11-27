import {
  activePrices,
  assessImageCost,
  Capability,
  filterCandidates,
  imageConstraintIssues,
  isProviderError,
  parseImageRequest,
  ProviderErrorOutcome,
  resolutionVariant,
  sanitizeProviderMessage,
  type CostAssessment,
  type GenerationContext,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type RoutingDecision,
} from '@acf/ai-core';
import type { AiInvocationStatus, Prisma, PrismaClient } from '@acf/database';

import { RoutingError } from './llm-service.js';
import type { CandidateRow, ModelCatalog } from './model-catalog.js';

/** The route for an image request: the model row and the reasons it was chosen. */
export interface ImageRoute {
  readonly row: CandidateRow;
  readonly decision: RoutingDecision;
}

/** The model cannot take the request as asked (counts, references, ratio, resolution, seed). */
export class ImageConstraintError extends Error {
  override readonly name = 'ImageConstraintError';
  constructor(
    readonly modelKey: string,
    readonly issues: readonly string[],
  ) {
    super(`${modelKey} cannot serve this request: ${issues.join('; ')}`);
  }
}

export interface ImageCallOptions {
  readonly providerKey?: string;
  readonly signal?: AbortSignal;
  /** `{jobId}:{attempt}:{call}` from the job layer. */
  readonly idempotencyKey?: string;
  /** Operator smoke test only: route to a disabled model so it can be tried before enabling. */
  readonly allowDisabled?: boolean;
}

export interface ImageCallResult {
  readonly result: ImageResult;
  readonly invocationId: string;
  readonly cost: CostAssessment;
}

export interface ImageServiceOptions {
  /** Output pixels of one decoded image (for per-megapixel prices), or null if unreadable. */
  readonly pixelsOf: (bytes: Uint8Array) => number | null;
}

/** Parameters a request needs its model to declare (absent = unsupported, verification §1). */
function requiredParameters(request: ImageRequest): Set<string> {
  const required = new Set<string>();
  if (request.count > 1) required.add('n');
  if (request.resolution !== undefined) required.add('resolution');
  if (request.seed !== undefined) required.add('seed');
  if (request.references.length > 0) required.add('input_references');
  return required;
}

/**
 * The only entry point for image generation (M4 design §3, §5.3): route → persist intent →
 * call the `ImageProvider` → persist outcome, usage and cost (M2 ledger). Never retries.
 */
export class ImageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: ModelCatalog,
    private readonly providers: ReadonlyMap<string, ImageProvider>,
    private readonly options: ImageServiceOptions,
  ) {}

  /**
   * Resolves the model for a request without calling it (used for estimates and validation).
   * @throws {RoutingError} no eligible model; {@link ImageConstraintError} limits exceeded.
   */
  async route(
    context: Pick<GenerationContext, 'qualityTier'>,
    request: Pick<
      ImageRequest,
      'modelKey' | 'aspectRatio' | 'resolution' | 'count' | 'seed' | 'references'
    >,
    options: Pick<ImageCallOptions, 'providerKey' | 'allowDisabled'> = {},
  ): Promise<ImageRoute> {
    const rows = (
      await this.catalog.candidates(Capability.IMAGE_GENERATION, request.modelKey)
    ).filter(
      (r) => options.providerKey === undefined || r.candidate.providerKey === options.providerKey,
    );
    const decision = filterCandidates(
      rows.map((r) =>
        options.allowDisabled
          ? { ...r.candidate, modelStatus: 'enabled' as const, providerStatus: 'enabled' as const }
          : r.candidate,
      ),
      {
        capability: Capability.IMAGE_GENERATION,
        parameters: requiredParameters(request as ImageRequest),
        minimumTier: context.qualityTier,
        modelKey: request.modelKey,
      },
    );
    const chosen = decision.eligible[0];
    const row = chosen && rows.find((r) => r.candidate.modelId === chosen.modelId);
    if (!row) throw new RoutingError(request.modelKey, decision);
    const issues = imageConstraintIssues(request, row.imageConstraints);
    if (issues.length > 0) throw new ImageConstraintError(request.modelKey, issues);
    return { row, decision };
  }

  async generate(
    context: GenerationContext,
    input: ImageRequest,
    options: ImageCallOptions = {},
  ): Promise<ImageCallResult> {
    const request = parseImageRequest(input);
    const { row, decision } = await this.route(context, request, options);
    const provider = this.providers.get(row.candidate.providerKey);
    if (!provider) throw new RoutingError(request.modelKey, decision); // unreachable: filtered

    const invocation = await this.prisma.aiInvocation.create({
      data: {
        projectId: context.projectId,
        contentItemId: context.contentItemId ?? null,
        generationJobId: context.generationJobId ?? null,
        correlationId: context.correlationId,
        idempotencyKey: options.idempotencyKey ?? null,
        capability: Capability.IMAGE_GENERATION,
        providerId: row.providerId,
        modelId: row.candidate.modelId,
        requestSummary: requestSummary(request, decision),
      },
      select: { id: true, startedAt: true },
    });
    const prices = activePrices(row.prices, invocation.startedAt);
    const variant = resolutionVariant(request.resolution);

    let result: ImageResult;
    try {
      result = await provider.generate(
        request,
        context,
        options.signal ?? new AbortController().signal,
      );
    } catch (error) {
      await this.recordFailure(invocation.id, error);
      throw error;
    }
    let outputPixels: number | null = 0;
    for (const image of result.images) {
      const pixels = this.options.pixelsOf(image.bytes);
      outputPixels = pixels === null || outputPixels === null ? null : outputPixels + pixels;
    }
    const usage = { ...result.usage, inputImages: request.references.length, outputPixels };
    const cost = assessImageCost({ usage, prices, reportedCost: result.reportedCost, variant });
    await this.recordOutcome(invocation.id, 'succeeded', cost, {
      servedModel: result.servedModel,
      providerRequestId: result.providerRequestId,
      latencyMs: result.latencyMs,
    });
    return { result: { ...result, usage }, invocationId: invocation.id, cost };
  }

  private async recordFailure(invocationId: string, error: unknown): Promise<void> {
    if (!isProviderError(error)) {
      await this.recordOutcome(invocationId, 'failed', null, {
        errorCode: 'INTERNAL_ERROR',
        errorMessage: sanitizeProviderMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }
    // Image billing is all-or-nothing: a failed generation carries at most a reported cost.
    const cost: CostAssessment | null = error.reportedCost
      ? { status: 'reported', reportedCost: error.reportedCost, estimatedCost: null, lines: [] }
      : null;
    await this.recordOutcome(
      invocationId,
      error.outcome === ProviderErrorOutcome.UNKNOWN ? 'outcome_unknown' : 'failed',
      cost,
      {
        errorCode: error.code,
        errorMessage: error.message,
        providerRequestId: error.providerRequestId ?? null,
      },
    );
  }

  private async recordOutcome(
    invocationId: string,
    status: Exclude<AiInvocationStatus, 'started'>,
    cost: CostAssessment | null,
    fields: Partial<{
      servedModel: string | null;
      providerRequestId: string | null;
      latencyMs: number;
      errorCode: string;
      errorMessage: string;
    }>,
  ): Promise<void> {
    const costFields = cost
      ? {
          costStatus: cost.status,
          reportedCost: cost.reportedCost?.toString() ?? null,
          estimatedCost: cost.estimatedCost?.toString() ?? null,
        }
      : { costStatus: 'unknown' as const, reportedCost: null, estimatedCost: null };
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.aiInvocation.updateMany({
        where: { id: invocationId, status: 'started' },
        data: { status, completedAt: new Date(), ...costFields, ...fields },
      });
      if (count !== 1) throw new Error(`invocation ${invocationId} already has an outcome`);
      if (cost && cost.lines.length > 0) {
        const { projectId } = await tx.aiInvocation.findUniqueOrThrow({
          where: { id: invocationId },
          select: { projectId: true },
        });
        await tx.aiUsageRecord.createMany({
          data: cost.lines.map((line) => ({
            invocationId,
            projectId,
            metric: line.metric,
            quantity: BigInt(line.quantity),
            unitPrice: line.unitPrice?.toString() ?? null,
            cost: line.cost?.toString() ?? null,
            priceId: line.priceId,
            source: 'calculated' as const,
          })),
        });
      }
    });
  }
}

/** Parameters and routing only: never the prompt, reference bytes or credentials. */
function requestSummary(request: ImageRequest, decision: RoutingDecision): Prisma.InputJsonObject {
  return {
    modelKey: request.modelKey,
    promptChars: request.prompt.length,
    aspectRatio: request.aspectRatio,
    count: request.count,
    references: request.references.length,
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    zeroDataRetention: request.dataPolicy?.zeroDataRetention ?? false,
    routing: [...decision.explanation],
  };
}
