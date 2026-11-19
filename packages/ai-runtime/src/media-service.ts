import {
  activePrices,
  assessTtsCost,
  assessVideoCost,
  Capability,
  filterCandidates,
  parseTtsRequest,
  parseVideoRequest,
  ttsConstraintIssues,
  videoConstraintIssues,
  type CostAssessment,
  type GenerationContext,
  type RoutingDecision,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type UsdAmount,
  type VideoDownload,
  type VideoJobState,
  type VideoProvider,
  type VideoRequest,
} from '@acf/ai-core';
import type { Prisma, PrismaClient } from '@acf/database';

import { recordInvocationFailure, recordInvocationOutcome } from './ledger.js';
import { RoutingError } from './llm-service.js';
import { toPriceComponents, type CandidateRow, type ModelCatalog } from './model-catalog.js';

/** The model cannot take the request as asked (duration, resolution, ratio, voice …). */
export class MediaConstraintError extends Error {
  override readonly name = 'MediaConstraintError';
  constructor(
    readonly modelKey: string,
    readonly issues: readonly string[],
  ) {
    super(`${modelKey} cannot serve this request: ${issues.join('; ')}`);
  }
}

export interface MediaRoute {
  readonly row: CandidateRow;
  readonly decision: RoutingDecision;
}

export interface MediaCallOptions {
  readonly providerKey?: string;
  readonly signal?: AbortSignal;
  /** `{jobId}:{attempt}:{call}` from the job layer: one invocation per submission. */
  readonly idempotencyKey?: string;
  /** Operator smoke test only: route to a disabled model so it can be tried before enabling. */
  readonly allowDisabled?: boolean;
}

export interface VideoSubmitOptions extends MediaCallOptions {
  /**
   * Called after the invocation is recorded and right before the paid submit call: the job layer
   * persists its submission intent here (decision V3). Throwing aborts before anything is sent;
   * the invocation is then recorded as failed (not sent).
   */
  readonly beforeSubmit?: (invocationId: string, providerKey: string) => Promise<void>;
}

async function routeFor(
  catalog: ModelCatalog,
  capability: typeof Capability.VIDEO_GENERATION | typeof Capability.TTS,
  context: Pick<GenerationContext, 'qualityTier'>,
  modelKey: string,
  options: Pick<MediaCallOptions, 'providerKey' | 'allowDisabled'>,
): Promise<MediaRoute> {
  const rows = (await catalog.candidates(capability, modelKey)).filter(
    (r) => options.providerKey === undefined || r.candidate.providerKey === options.providerKey,
  );
  const decision = filterCandidates(
    rows.map((r) =>
      options.allowDisabled
        ? { ...r.candidate, modelStatus: 'enabled' as const, providerStatus: 'enabled' as const }
        : r.candidate,
    ),
    { capability, parameters: new Set(), minimumTier: context.qualityTier, modelKey },
  );
  const chosen = decision.eligible[0];
  const row = chosen && rows.find((r) => r.candidate.modelId === chosen.modelId);
  if (!row) throw new RoutingError(modelKey, decision);
  return { row, decision };
}

async function startInvocation(
  prisma: PrismaClient,
  context: GenerationContext,
  capability: 'video_generation' | 'tts',
  row: CandidateRow,
  idempotencyKey: string | undefined,
  summary: Prisma.InputJsonObject,
): Promise<{ id: string; startedAt: Date }> {
  return prisma.aiInvocation.create({
    data: {
      projectId: context.projectId,
      contentItemId: context.contentItemId ?? null,
      generationJobId: context.generationJobId ?? null,
      correlationId: context.correlationId,
      idempotencyKey: idempotencyKey ?? null,
      capability,
      providerId: row.providerId,
      modelId: row.candidate.modelId,
      requestSummary: summary,
    },
    select: { id: true, startedAt: true },
  });
}

export interface VideoSubmission {
  readonly invocationId: string;
  readonly state: VideoJobState;
  readonly providerKey: string;
  /** Estimate for the billed seconds at submission prices (null = unknown). */
  readonly estimatedCost: UsdAmount | null;
}

/**
 * Video generation (M5 design §3, §5): route → persist intent → submit; the job layer then polls
 * and finally records the outcome. One invocation per submission spans submit → terminal state,
 * so its cost is assessed with the prices in force when it was submitted. Never retries.
 */
export class VideoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: ModelCatalog,
    private readonly providers: ReadonlyMap<string, VideoProvider>,
  ) {}

  /** @throws {RoutingError | MediaConstraintError} */
  async route(
    context: Pick<GenerationContext, 'qualityTier'>,
    request: Pick<
      VideoRequest,
      | 'modelKey'
      | 'durationSeconds'
      | 'resolution'
      | 'aspectRatio'
      | 'generateAudio'
      | 'seed'
      | 'firstFrame'
    >,
    options: Pick<MediaCallOptions, 'providerKey' | 'allowDisabled'> = {},
  ): Promise<MediaRoute> {
    const route = await routeFor(
      this.catalog,
      Capability.VIDEO_GENERATION,
      context,
      request.modelKey,
      options,
    );
    const issues = videoConstraintIssues(request, route.row.videoConstraints);
    if (issues.length > 0) throw new MediaConstraintError(request.modelKey, issues);
    return route;
  }

  /**
   * Submits once. On a provider error the invocation gets its outcome (`outcome_unknown` when
   * the submit may have been accepted) and the error is rethrown for the job layer.
   */
  async submit(
    context: GenerationContext,
    input: VideoRequest,
    options: VideoSubmitOptions = {},
  ): Promise<VideoSubmission> {
    const request = parseVideoRequest(input);
    const { row, decision } = await this.route(context, request, options);
    const provider = this.providers.get(row.candidate.providerKey);
    if (!provider) throw new RoutingError(request.modelKey, decision);
    const invocation = await startInvocation(
      this.prisma,
      context,
      Capability.VIDEO_GENERATION,
      row,
      options.idempotencyKey,
      videoSummary(request, decision),
    );
    const estimate = assessVideoCost({
      usage: videoUsage(request),
      prices: activePrices(row.prices, invocation.startedAt),
      reportedCost: null,
    }).estimatedCost;
    let state: VideoJobState;
    try {
      await options.beforeSubmit?.(invocation.id, row.candidate.providerKey);
      state = await provider.submit(
        request,
        context,
        options.signal ?? new AbortController().signal,
      );
    } catch (error) {
      await recordInvocationFailure(this.prisma, invocation.id, error);
      throw error;
    }
    await this.prisma.aiInvocation.update({
      where: { id: invocation.id },
      // The estimate goes on the outcome (ledger CHECK: cost fields follow the cost status).
      data: { providerRequestId: state.providerJobId },
    });
    return {
      invocationId: invocation.id,
      state,
      providerKey: row.candidate.providerKey,
      estimatedCost: estimate,
    };
  }

  /** Reads a provider job's state (free; no ledger write). */
  poll(
    providerKey: string,
    providerJobId: string,
    context: GenerationContext,
    signal?: AbortSignal,
  ): Promise<VideoJobState> {
    return this.provider(providerKey).poll(
      providerJobId,
      context,
      signal ?? new AbortController().signal,
    );
  }

  download(
    providerKey: string,
    providerJobId: string,
    index: number,
    context: GenerationContext,
    signal?: AbortSignal,
  ): Promise<VideoDownload> {
    return this.provider(providerKey).download(
      providerJobId,
      index,
      context,
      signal ?? new AbortController().signal,
    );
  }

  /** Completed at the provider: final cost (reported, else estimated) and usage lines. */
  async complete(
    invocationId: string,
    request: VideoRequest,
    state: VideoJobState,
  ): Promise<CostAssessment> {
    const invocation = await this.prisma.aiInvocation.findUniqueOrThrow({
      where: { id: invocationId },
      select: { startedAt: true, model: { select: { prices: true } } },
    });
    const cost = assessVideoCost({
      usage: videoUsage(request),
      prices: activePrices(toPriceComponents(invocation.model.prices), invocation.startedAt),
      reportedCost: state.reportedCost,
    });
    await recordInvocationOutcome(this.prisma, invocationId, 'succeeded', cost, {
      providerRequestId: state.providerJobId,
    });
    return cost;
  }

  /**
   * Ended without a usable output (failed, cancelled, expired at the provider; or the output was
   * invalid). A reported cost is kept; otherwise the cost is unknown (it may still be charged).
   */
  async fail(
    invocationId: string,
    state: Pick<VideoJobState, 'providerJobId' | 'reportedCost'>,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await recordInvocationOutcome(
      this.prisma,
      invocationId,
      'failed',
      state.reportedCost
        ? { status: 'reported', reportedCost: state.reportedCost, estimatedCost: null, lines: [] }
        : null,
      {
        providerRequestId: state.providerJobId,
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
      },
    );
  }

  /** The job will not be followed any more (timeout): the provider may still finish and charge. */
  async abandon(invocationId: string, errorCode: string, errorMessage: string): Promise<void> {
    await recordInvocationOutcome(this.prisma, invocationId, 'outcome_unknown', null, {
      errorCode,
      errorMessage: errorMessage.slice(0, 500),
    });
  }

  private provider(providerKey: string): VideoProvider {
    const provider = this.providers.get(providerKey);
    if (!provider) throw new Error(`no video adapter for provider ${providerKey}`);
    return provider;
  }
}

export interface TtsCallResult {
  readonly result: TtsResult;
  readonly invocationId: string;
  readonly cost: CostAssessment;
}

/** TTS (M5 design §4, §7): route → persist intent → synthesize → persist outcome and cost. */
export class TtsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: ModelCatalog,
    private readonly providers: ReadonlyMap<string, TtsProvider>,
  ) {}

  /** @throws {RoutingError | MediaConstraintError} */
  async route(
    context: Pick<GenerationContext, 'qualityTier'>,
    request: Pick<TtsRequest, 'modelKey' | 'voice'>,
    options: Pick<MediaCallOptions, 'providerKey' | 'allowDisabled'> = {},
  ): Promise<MediaRoute> {
    const route = await routeFor(this.catalog, Capability.TTS, context, request.modelKey, options);
    const issues = ttsConstraintIssues(request, route.row.ttsConstraints);
    if (issues.length > 0) throw new MediaConstraintError(request.modelKey, issues);
    return route;
  }

  async synthesize(
    context: GenerationContext,
    input: TtsRequest,
    options: MediaCallOptions = {},
  ): Promise<TtsCallResult> {
    const request = parseTtsRequest(input);
    const { row, decision } = await this.route(context, request, options);
    const provider = this.providers.get(row.candidate.providerKey);
    if (!provider) throw new RoutingError(request.modelKey, decision);
    const invocation = await startInvocation(
      this.prisma,
      context,
      Capability.TTS,
      row,
      options.idempotencyKey,
      {
        modelKey: request.modelKey,
        textChars: request.text.length,
        voice: request.voice,
        ...(request.language ? { language: request.language } : {}),
        ...(request.speed === undefined ? {} : { speed: request.speed }),
        zeroDataRetention: request.dataPolicy?.zeroDataRetention ?? false,
        routing: [...decision.explanation],
      },
    );
    let result: TtsResult;
    try {
      result = await provider.synthesize(
        request,
        context,
        options.signal ?? new AbortController().signal,
      );
    } catch (error) {
      await recordInvocationFailure(this.prisma, invocation.id, error);
      throw error;
    }
    const cost = assessTtsCost({
      characters: result.characters,
      prices: activePrices(row.prices, invocation.startedAt),
      reportedCost: result.reportedCost,
    });
    await recordInvocationOutcome(this.prisma, invocation.id, 'succeeded', cost, {
      providerRequestId: result.providerRequestId,
      latencyMs: result.latencyMs,
    });
    return { result, invocationId: invocation.id, cost };
  }
}

const videoUsage = (request: VideoRequest) => ({
  seconds: request.durationSeconds,
  inputImages: request.firstFrame ? 1 : 0,
  resolution: request.resolution,
  audio: request.generateAudio,
});

/** Parameters and routing only: never the prompt, frame bytes or credentials. */
function videoSummary(request: VideoRequest, decision: RoutingDecision): Prisma.InputJsonObject {
  return {
    modelKey: request.modelKey,
    promptChars: request.prompt.length,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    generateAudio: request.generateAudio,
    firstFrame: request.firstFrame !== undefined,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    routing: [...decision.explanation],
  };
}
