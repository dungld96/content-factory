import { Inject, Injectable } from '@nestjs/common';

import {
  activePrices,
  effectiveParameters,
  type LlmProvider,
  type ModelCandidate,
  type PriceComponent,
} from '@acf/ai-core';
import type {
  AiModelDetailDto,
  AiModelDto,
  AiPriceDto,
  AiProviderDto,
  AiProviderList,
  ListAiModelsQuery,
  Page,
} from '@acf/contracts';
import type {
  AiCapability,
  AiModel,
  AiModelCapability,
  AiModelPrice,
  AiProvider,
} from '@acf/database';

import { notFound } from '../../common/domain-errors.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../../common/http/pagination.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { LLM_PROVIDERS } from '../ai.tokens.js';
import { usdFromDecimal } from '../money.js';

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
    effectiveFrom: p.effectiveFrom.toISOString(),
    source: p.source,
    sourceUrl: p.sourceUrl,
    capturedAt: p.capturedAt.toISOString(),
  };
}

/** Registry price rows → ai-core price components (exact USD). */
export function toPriceComponents(prices: readonly AiModelPrice[]): PriceComponent[] {
  return prices.map((p) => ({
    id: p.id,
    metric: p.metric,
    unitPrice: usdFromDecimal(p.unitPrice),
    minPromptTokens: p.minPromptTokens,
    effectiveFrom: p.effectiveFrom,
  }));
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
  ) {}

  /** Credentials for this provider are configured in this deployment. */
  isConfigured(providerKey: string): boolean {
    return this.llmProviders.has(providerKey);
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

  /**
   * Routing candidates for a capability, restricted to one model key (M2 callers name the model).
   * Parameters are limited to what the provider's adapter can send.
   */
  async candidates(capability: AiCapability, modelKey: string): Promise<CandidateRow[]> {
    const rows = await this.prisma.client.aiModel.findMany({
      where: { modelKey, capabilities: { some: { capability } } },
      include: MODEL_INCLUDE,
      orderBy: { provider: { key: 'asc' } },
    });
    return rows.map((row) => {
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
      return { candidate, providerId: row.providerId, prices: toPriceComponents(row.prices) };
    });
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
      isFreeVariant: row.isFreeVariant,
      rateLimitNotes: row.rateLimitNotes,
      dataPolicyNotes: row.dataPolicyNotes,
      benchmarkScore: row.benchmarkScore === null ? null : row.benchmarkScore.toFixed(2),
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      activePrices: row.prices.filter((p) => activeIds.has(p.id)).map(toPriceDto),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export interface CandidateRow {
  readonly candidate: ModelCandidate;
  readonly providerId: string;
  /** Every price row of the model (history included); select with `activePrices(at)`. */
  readonly prices: readonly PriceComponent[];
}
