import { Inject, Injectable } from '@nestjs/common';

import {
  activePrices,
  ttsConstraintsSchema,
  type ImageProvider,
  type LlmProvider,
  type TtsProvider,
  type VideoProvider,
} from '@acf/ai-core';
import { toPriceComponents, usdFromDecimal } from '@acf/ai-runtime';
import type {
  AiModelDetailDto,
  AiModelDto,
  AiPriceDto,
  AiProviderDto,
  AiProviderList,
  AiRegistryEventDto,
  AiRouteList,
  AiTask,
  ListAiModelsQuery,
  Page,
} from '@acf/contracts';
import type { AiModel, AiModelCapability, AiModelPrice, AiProvider } from '@acf/database';

import { notFound } from '../../common/domain-errors.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { IMAGE_PROVIDERS, LLM_PROVIDERS, TTS_PROVIDERS, VIDEO_PROVIDERS } from '../ai.tokens.js';

const ROUTED_TASKS: readonly AiTask[] = [
  'script_generation',
  'storyboard_generation',
  'image_generation',
  'video_generation',
  'tts_generation',
];

type ModelRow = AiModel & {
  provider: AiProvider;
  capabilities: AiModelCapability[];
  prices: AiModelPrice[];
};

const MODEL_INCLUDE = {
  provider: true,
  capabilities: true,
  prices: { orderBy: [{ effectiveFrom: 'desc' as const }, { id: 'desc' as const }] },
};

export function toPriceDto(p: AiModelPrice): AiPriceDto {
  return {
    id: p.id,
    metric: p.metric,
    unitPriceUsd: usdFromDecimal(p.unitPrice).toString(),
    sourceValue: p.sourceValue,
    currency: 'USD',
    minPromptTokens: p.minPromptTokens,
    variant: p.variant,
    effectiveFrom: p.effectiveFrom.toISOString(),
    source: p.source,
    sourceUrl: p.sourceUrl,
    capturedAt: p.capturedAt.toISOString(),
  };
}

/**
 * Read side of the provider/model registry (design package §3.2, §8.2). Registry data is global
 * (not project-scoped): any authenticated user may read it; only the operator CLI writes it.
 */
@Injectable()
export class RegistryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDERS) private readonly llmProviders: ReadonlyMap<string, LlmProvider>,
    @Inject(IMAGE_PROVIDERS) private readonly imageProviders: ReadonlyMap<string, ImageProvider>,
    @Inject(VIDEO_PROVIDERS) private readonly videoProviders: ReadonlyMap<string, VideoProvider>,
    @Inject(TTS_PROVIDERS) private readonly ttsProviders: ReadonlyMap<string, TtsProvider>,
  ) {}

  /** Credentials for this provider are configured in this deployment, for any capability (P1 O2). */
  isConfigured(providerKey: string): boolean {
    return [this.llmProviders, this.imageProviders, this.videoProviders, this.ttsProviders].some(
      (map) => map.has(providerKey),
    );
  }

  /** Credentials for this provider are configured for one capability (routing check, P1 O4). */
  isConfiguredFor(capability: string, providerKey: string): boolean {
    const map =
      capability === 'image_generation'
        ? this.imageProviders
        : capability === 'video_generation'
          ? this.videoProviders
          : capability === 'tts'
            ? this.ttsProviders
            : this.llmProviders;
    return map.has(providerKey);
  }

  /** Every task with its routed model (P1 O4); `model: null` when no route is set. */
  async listRoutes(): Promise<AiRouteList> {
    const rows = await this.prisma.client.aiTaskRoute.findMany({
      include: { model: { include: { provider: true } } },
    });
    return {
      data: ROUTED_TASKS.map((task) => {
        const r = rows.find((row) => row.task === task);
        return {
          task,
          model: r
            ? {
                id: r.model.id,
                modelKey: r.model.modelKey,
                displayName: r.model.displayName,
                status: r.model.status,
              }
            : null,
          provider: r
            ? {
                key: r.model.provider.key,
                status: r.model.provider.status,
                configured: this.isConfigured(r.model.provider.key),
              }
            : null,
          zeroDataRetention: r?.zeroDataRetention ?? false,
          updatedAt: r?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  }

  /** The registry audit, newest first (P1 O6; operators). */
  async listEvents(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<AiRegistryEventDto>> {
    const rows = await this.prisma.client.aiRegistryEvent.findMany({
      where: keysetAfter(query.cursor),
      include: { actor: { select: { id: true, email: true, displayName: true } } },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (e) => ({
      id: e.id,
      source: e.source === 'api' ? 'api' : 'cli',
      actor: e.actor,
      action: e.action,
      target: e.target,
      before: e.before ?? null,
      after: e.after ?? null,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async listProviders(): Promise<AiProviderList> {
    const rows = await this.prisma.client.aiProvider.findMany({ orderBy: { key: 'asc' } });
    return { data: rows.map((p) => this.toProviderDto(p)) };
  }

  async listModels(query: ListAiModelsQuery): Promise<Page<AiModelDto>> {
    const rows = await this.prisma.client.aiModel.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.qualityTier ? { qualityTier: query.qualityTier } : {}),
        ...(query.capability ? { capabilities: { some: { capability: query.capability } } } : {}),
        ...(query.providerKey ? { provider: { key: query.providerKey } } : {}),
        ...keysetAfter(query.cursor),
      },
      include: MODEL_INCLUDE,
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    const now = new Date();
    return toPage(rows, query.limit, (row) => this.toModelDto(row, now));
  }

  async getModel(modelId: string): Promise<AiModelDetailDto> {
    const row = await this.prisma.client.aiModel.findUnique({
      where: { id: modelId },
      include: MODEL_INCLUDE,
    });
    if (!row) throw notFound('model');
    return { ...this.toModelDto(row, new Date()), priceHistory: row.prices.map(toPriceDto) };
  }

  private toProviderDto(p: AiProvider): AiProviderDto {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      kind: p.kind as AiProviderDto['kind'],
      status: p.status,
      configured: this.isConfigured(p.key),
      termsUrl: p.termsUrl,
      dataPolicyUrl: p.dataPolicyUrl,
      notes: p.notes,
    };
  }

  private toModelDto(row: ModelRow, now: Date): AiModelDto {
    const activeIds = new Set(activePrices(toPriceComponents(row.prices), now).map((p) => p.id));
    return {
      id: row.id,
      providerKey: row.provider.key,
      modelKey: row.modelKey,
      canonicalSlug: row.canonicalSlug,
      displayName: row.displayName,
      capabilities: row.capabilities.map((c) => c.capability).sort(),
      supportedParameters: row.supportedParameters,
      inputModalities: row.inputModalities,
      outputModalities: row.outputModalities,
      contextLength: row.contextLength,
      maxOutputTokens: row.maxOutputTokens,
      qualityTier: row.qualityTier,
      status: row.status,
      schemaMode: row.schemaMode === 'basic' ? 'basic' : 'full',
      isFreeVariant: row.isFreeVariant,
      rateLimitNotes: row.rateLimitNotes,
      dataPolicyNotes: row.dataPolicyNotes,
      benchmarkScore: row.benchmarkScore === null ? null : row.benchmarkScore.toFixed(2),
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      activePrices: row.prices.filter((p) => activeIds.has(p.id)).map(toPriceDto),
      voices: (() => {
        const tts = ttsConstraintsSchema.safeParse(row.mediaConstraints);
        return tts.success && tts.data.voices.length > 0 ? tts.data.voices : null;
      })(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
