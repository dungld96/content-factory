import {
  effectiveParameters,
  imageConstraintsSchema,
  ttsConstraintsSchema,
  videoConstraintsSchema,
  type ImageConstraints,
  type ImageProvider,
  type LlmProvider,
  type ModelCandidate,
  type PriceComponent,
  type TtsConstraints,
  type TtsProvider,
  type VideoConstraints,
  type VideoProvider,
} from '@acf/ai-core';
import type { AiCapability, AiModelPrice, PrismaClient } from '@acf/database';

import { usdFromDecimal } from './money.js';

const PRICE_ORDER = [{ effectiveFrom: 'desc' as const }, { id: 'desc' as const }];

/** Registry price rows → ai-core price components (exact USD). */
export function toPriceComponents(prices: readonly AiModelPrice[]): PriceComponent[] {
  return prices.map((p) => ({
    id: p.id,
    metric: p.metric,
    unitPrice: usdFromDecimal(p.unitPrice),
    minPromptTokens: p.minPromptTokens,
    variant: p.variant,
    effectiveFrom: p.effectiveFrom,
  }));
}

/**
 * Routing view of the model registry (M2 design §7.4), shared by the API and the worker.
 */
export class ModelCatalog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly llmProviders: ReadonlyMap<string, LlmProvider>,
    /** Image adapters (M4); image models are "configured" only when their provider has one. */
    private readonly imageProviders: ReadonlyMap<string, ImageProvider> = new Map(),
    /** Video and TTS adapters (M5), likewise. */
    private readonly videoProviders: ReadonlyMap<string, VideoProvider> = new Map(),
    private readonly ttsProviders: ReadonlyMap<string, TtsProvider> = new Map(),
  ) {}

  /**
   * Routing candidates for a capability, restricted to one model key (M2 callers name the model).
   * Parameters are limited to what the provider's adapter can send.
   */
  async candidates(capability: AiCapability, modelKey: string): Promise<CandidateRow[]> {
    const rows = await this.prisma.aiModel.findMany({
      where: { modelKey, capabilities: { some: { capability } } },
      include: { provider: true, capabilities: true, prices: { orderBy: PRICE_ORDER } },
      orderBy: { provider: { key: 'asc' } },
    });
    return rows.map((row) => {
      if (capability === 'video_generation' || capability === 'tts') {
        const adapters = capability === 'tts' ? this.ttsProviders : this.videoProviders;
        const video = videoConstraintsSchema.safeParse(row.mediaConstraints);
        const tts = ttsConstraintsSchema.safeParse(row.mediaConstraints);
        return {
          candidate: {
            modelId: row.id,
            modelKey: row.modelKey,
            providerKey: row.provider.key,
            capabilities: row.capabilities.map((c) => c.capability),
            supportedParameters: row.supportedParameters,
            qualityTier: row.qualityTier,
            modelStatus: row.status,
            providerStatus: row.provider.status,
            providerConfigured: adapters.has(row.provider.key),
          },
          providerId: row.providerId,
          prices: toPriceComponents(row.prices),
          imageConstraints: null,
          videoConstraints: video.success ? video.data : null,
          ttsConstraints: tts.success ? tts.data : null,
        };
      }
      if (capability === 'image_generation') {
        const constraints = imageConstraintsSchema.safeParse(row.imageConstraints);
        const candidate: ModelCandidate = {
          modelId: row.id,
          modelKey: row.modelKey,
          providerKey: row.provider.key,
          capabilities: row.capabilities.map((c) => c.capability),
          // Image adapters send whatever the model's endpoint record declares.
          supportedParameters: row.supportedParameters,
          qualityTier: row.qualityTier,
          modelStatus: row.status,
          providerStatus: row.provider.status,
          providerConfigured: this.imageProviders.has(row.provider.key),
        };
        return {
          candidate,
          providerId: row.providerId,
          prices: toPriceComponents(row.prices),
          imageConstraints: constraints.success ? constraints.data : null,
          videoConstraints: null,
          ttsConstraints: null,
        };
      }
      const adapter = this.llmProviders.get(row.provider.key);
      const candidate: ModelCandidate = {
        modelId: row.id,
        modelKey: row.modelKey,
        providerKey: row.provider.key,
        capabilities: row.capabilities.map((c) => c.capability),
        supportedParameters: effectiveParameters(
          row.supportedParameters,
          adapter?.supportedParameters ?? new Set<string>(),
        ),
        qualityTier: row.qualityTier,
        modelStatus: row.status,
        providerStatus: row.provider.status,
        providerConfigured: adapter !== undefined,
      };
      return {
        candidate,
        providerId: row.providerId,
        prices: toPriceComponents(row.prices),
        imageConstraints: null,
        videoConstraints: null,
        ttsConstraints: null,
      };
    });
  }
}

export interface CandidateRow {
  readonly candidate: ModelCandidate;
  readonly providerId: string;
  /** Every price row of the model (history included); select with `activePrices(at)`. */
  readonly prices: readonly PriceComponent[];
  /** Image models only (M4); `null` otherwise or when not recorded. */
  readonly imageConstraints: ImageConstraints | null;
  /** Video models only (M5). */
  readonly videoConstraints: VideoConstraints | null;
  /** TTS models only (M5). */
  readonly ttsConstraints: TtsConstraints | null;
}
