import { UsdAmount, type PriceMetric } from '@acf/ai-core';
import type {
  AiPriceSource,
  AiProviderStatus,
  AiQualityTier,
  GenerationJobKind,
  PrismaClient,
} from '@acf/database';

import { usdFromDecimal } from '@acf/ai-runtime';
import type { ImportPlanEntry, PlannedModel } from '../providers/openrouter-catalog.js';

export class RegistryAdminError extends Error {
  override readonly name = 'RegistryAdminError';
}

/** Registry row for the OpenRouter gateway (verification record §4). */
export const OPENROUTER_PROVIDER_ROW = {
  key: 'openrouter',
  name: 'OpenRouter',
  kind: 'gateway',
  termsUrl: 'https://openrouter.ai/terms',
  dataPolicyUrl: 'https://openrouter.ai/docs/guides/privacy/data-collection',
  notes:
    'LLM gateway (text). Requests send data_collection=deny and require_parameters=true; zdr per call. Model commercial terms are per model.',
} as const;

export interface ImportOutcome {
  readonly modelKey: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'refused';
  readonly newPrices: number;
  readonly detail: string[];
}

/**
 * Operator-only registry writes (decision E3: CLI, never the HTTP API). Prices are appended,
 * never edited; models are created disabled and enabled only explicitly.
 */
export class RegistryAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  async setProviderStatus(key: string, status: AiProviderStatus): Promise<void> {
    const { count } = await this.prisma.aiProvider.updateMany({ where: { key }, data: { status } });
    if (count === 0) throw new RegistryAdminError(`unknown provider ${key}`);
  }

  async setModelStatus(
    providerKey: string,
    modelKey: string,
    status: AiProviderStatus,
  ): Promise<void> {
    const { count } = await this.prisma.aiModel.updateMany({
      where: { modelKey, provider: { key: providerKey } },
      data: { status },
    });
    if (count === 0) throw new RegistryAdminError(`unknown model ${providerKey}/${modelKey}`);
  }

  /**
   * Routes a generation task to a model (M3 Q4). The model needs the `llm` capability; it may be
   * disabled (generation then refuses with NO_MODEL_ROUTE until it is enabled).
   */
  async setRoute(
    task: GenerationJobKind,
    providerKey: string,
    modelKey: string,
  ): Promise<{ enabled: boolean }> {
    const model = await this.prisma.aiModel.findFirst({
      where: { modelKey, provider: { key: providerKey } },
      include: { capabilities: true, provider: true },
    });
    if (!model) throw new RegistryAdminError(`unknown model ${providerKey}/${modelKey}`);
    if (!model.capabilities.some((c) => c.capability === 'llm')) {
      throw new RegistryAdminError(`${providerKey}/${modelKey} has no llm capability`);
    }
    await this.prisma.aiTaskRoute.upsert({
      where: { task },
      create: { task, modelId: model.id },
      update: { modelId: model.id },
    });
    return { enabled: model.status === 'enabled' && model.provider.status === 'enabled' };
  }

  async addPrice(input: {
    providerKey: string;
    modelKey: string;
    metric: PriceMetric;
    usdPerUnit: string;
    source: AiPriceSource;
    sourceUrl: string;
    effectiveFrom?: Date;
    minPromptTokens?: number;
  }): Promise<string> {
    const model = await this.prisma.aiModel.findFirst({
      where: { modelKey: input.modelKey, provider: { key: input.providerKey } },
      select: { id: true },
    });
    if (!model)
      throw new RegistryAdminError(`unknown model ${input.providerKey}/${input.modelKey}`);
    let unitPrice: UsdAmount;
    try {
      unitPrice = UsdAmount.parse(input.usdPerUnit);
    } catch {
      throw new RegistryAdminError(`invalid USD amount ${JSON.stringify(input.usdPerUnit)}`);
    }
    const now = new Date();
    const row = await this.prisma.aiModelPrice.create({
      data: {
        modelId: model.id,
        metric: input.metric,
        unitPrice: unitPrice.toString(),
        sourceValue: input.usdPerUnit.trim(),
        minPromptTokens: input.minPromptTokens ?? 0,
        effectiveFrom: input.effectiveFrom ?? now,
        source: input.source,
        sourceUrl: input.sourceUrl,
        capturedAt: now,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Applies an OpenRouter import plan. New models need a quality tier and start disabled;
   * existing models keep their status and tier. A price row is appended only when the published
   * value differs from the latest row for that metric and tier.
   */
  async applyOpenRouterImport(
    plan: readonly ImportPlanEntry[],
    options: { tier?: AiQualityTier; sourceUrl: string; now?: Date },
  ): Promise<ImportOutcome[]> {
    const now = options.now ?? new Date();
    const provider = await this.prisma.aiProvider.upsert({
      where: { key: OPENROUTER_PROVIDER_ROW.key },
      create: { ...OPENROUTER_PROVIDER_ROW, status: 'disabled' },
      update: {},
      select: { id: true },
    });
    const outcomes: ImportOutcome[] = [];
    for (const entry of plan) {
      if (!entry.ok) {
        outcomes.push({
          modelKey: entry.modelKey,
          action: 'refused',
          newPrices: 0,
          detail: [entry.reason],
        });
        continue;
      }
      outcomes.push(
        await this.importModel(provider.id, entry.model, options.tier, options.sourceUrl, now),
      );
    }
    return outcomes;
  }

  private async importModel(
    providerId: string,
    m: PlannedModel,
    tier: AiQualityTier | undefined,
    sourceUrl: string,
    now: Date,
  ): Promise<ImportOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.aiModel.findUnique({
        where: { providerId_modelKey: { providerId, modelKey: m.modelKey } },
        include: { prices: { orderBy: { effectiveFrom: 'desc' } } },
      });
      if (!existing && tier === undefined) {
        return {
          modelKey: m.modelKey,
          action: 'refused' as const,
          newPrices: 0,
          detail: ['new model: pass --tier economy|balanced|premium'],
        };
      }
      const metadata = {
        canonicalSlug: m.canonicalSlug,
        displayName: m.displayName,
        supportedParameters: m.supportedParameters,
        inputModalities: m.inputModalities,
        outputModalities: m.outputModalities,
        contextLength: m.contextLength,
        maxOutputTokens: m.maxOutputTokens,
        isFreeVariant: m.isFreeVariant,
        expiresAt: m.expiresAt,
      };
      const model = existing
        ? await tx.aiModel.update({ where: { id: existing.id }, data: metadata })
        : await tx.aiModel.create({
            data: {
              providerId,
              modelKey: m.modelKey,
              qualityTier: tier ?? 'economy',
              status: 'disabled',
              ...metadata,
              ...(m.isFreeVariant
                ? {
                    rateLimitNotes:
                      'Free variant: 20 req/min; 50 or 1000 req/day (OpenRouter limits page). Never production capacity.',
                  }
                : {}),
            },
          });
      await tx.aiModelCapability.upsert({
        where: { modelId_capability: { modelId: model.id, capability: 'llm' } },
        create: { modelId: model.id, capability: 'llm' },
        update: {},
      });

      let newPrices = 0;
      const detail: string[] = [...m.warnings];
      for (const price of m.prices) {
        const latest = existing?.prices.find(
          (p) =>
            p.metric === price.metric &&
            p.minPromptTokens === price.minPromptTokens &&
            p.effectiveFrom <= now,
        );
        if (latest && usdFromDecimal(latest.unitPrice).equals(price.unitPrice)) continue;
        await tx.aiModelPrice.create({
          data: {
            modelId: model.id,
            metric: price.metric,
            unitPrice: price.unitPrice.toString(),
            sourceValue: price.sourceValue,
            minPromptTokens: price.minPromptTokens,
            effectiveFrom: now,
            source: 'official_api',
            sourceUrl,
            capturedAt: now,
          },
        });
        newPrices += 1;
        detail.push(
          `${price.metric}${price.minPromptTokens > 0 ? ` (≥${String(price.minPromptTokens)} prompt tokens)` : ''}: ${latest ? `${usdFromDecimal(latest.unitPrice).toString()} → ` : ''}${price.unitPrice.toString()} USD/unit`,
        );
      }
      const action = !existing ? 'created' : newPrices > 0 ? 'updated' : 'unchanged';
      return { modelKey: m.modelKey, action, newPrices, detail };
    });
  }
}
