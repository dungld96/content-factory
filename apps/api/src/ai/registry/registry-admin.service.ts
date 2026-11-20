import { UsdAmount, videoConstraintsSchema, type PriceMetric } from '@acf/ai-core';
import type {
  AiPriceSource,
  AiProviderStatus,
  AiQualityTier,
  GenerationJobKind,
  Prisma,
  PrismaClient,
} from '@acf/database';

import { usdFromDecimal } from '@acf/ai-runtime';
import type { ImportPlanEntry, PlannedModel } from '../providers/openrouter-catalog.js';
import type { ImagePlanEntry, PlannedImageModel } from '../providers/openrouter-image-catalog.js';
import type { MediaPlanEntry, PlannedMediaModel } from '../providers/openrouter-media-catalog.js';

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
   * Records a video model's minimum billed seconds (observed billing, not in the catalog), so
   * estimates and the spend guard bill at least that much. `null` removes it.
   */
  /** `full` | `basic` structured-output requests for an LLM (M8.5 Q2). */
  async setSchemaMode(
    providerKey: string,
    modelKey: string,
    mode: 'full' | 'basic',
  ): Promise<void> {
    const { count } = await this.prisma.aiModel.updateMany({
      where: {
        modelKey,
        provider: { key: providerKey },
        capabilities: { some: { capability: 'llm' } },
      },
      data: { schemaMode: mode },
    });
    if (count === 0)
      throw new RegistryAdminError(`${providerKey}/${modelKey} is not a registered text model`);
  }

  async setMinBilledSeconds(
    providerKey: string,
    modelKey: string,
    seconds: number | null,
  ): Promise<void> {
    const model = await this.prisma.aiModel.findFirst({
      where: { modelKey, provider: { key: providerKey } },
      select: { id: true, mediaConstraints: true },
    });
    const parsed = videoConstraintsSchema.safeParse(model?.mediaConstraints);
    if (!model || !parsed.success) {
      throw new RegistryAdminError(
        `${providerKey}/${modelKey} is not a video model with constraints`,
      );
    }
    const next: Record<string, unknown> = { ...parsed.data, minBilledSeconds: seconds };
    if (seconds === null) delete next['minBilledSeconds'];
    await this.prisma.aiModel.update({
      where: { id: model.id },
      data: { mediaConstraints: next as Prisma.InputJsonObject },
    });
  }

  /**
   * Routes a generation task to a model (M3 Q4). Text tasks need the `llm` capability, image
   * generation (M4) the `image_generation` capability. The model may be disabled (generation then
   * refuses with NO_MODEL_ROUTE until it is enabled).
   */
  async setRoute(
    task: GenerationJobKind,
    providerKey: string,
    modelKey: string,
    /** Route only to zero-data-retention endpoints (M4 decision G9). */
    zeroDataRetention = false,
  ): Promise<{ enabled: boolean }> {
    const model = await this.prisma.aiModel.findFirst({
      where: { modelKey, provider: { key: providerKey } },
      include: { capabilities: true, provider: true },
    });
    if (!model) throw new RegistryAdminError(`unknown model ${providerKey}/${modelKey}`);
    const needed =
      task === 'image_generation' || task === 'video_generation'
        ? task
        : task === 'tts_generation'
          ? 'tts'
          : 'llm';
    if (!model.capabilities.some((c) => c.capability === needed)) {
      throw new RegistryAdminError(`${providerKey}/${modelKey} has no ${needed} capability`);
    }
    await this.prisma.aiTaskRoute.upsert({
      where: { task },
      create: { task, modelId: model.id, zeroDataRetention },
      update: { modelId: model.id, zeroDataRetention },
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

  /**
   * Applies an OpenRouter image import plan (M4 design §3.3). Like the text import: new models
   * need a tier and start disabled; a price row is appended only when the published value for
   * that metric and resolution tier changed.
   */
  async applyOpenRouterImageImport(
    plan: readonly ImagePlanEntry[],
    options: { tier?: AiQualityTier; sourceUrl: (modelKey: string) => string; now?: Date },
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
        await this.importImageModel(
          provider.id,
          entry.model,
          options.tier,
          options.sourceUrl(entry.modelKey),
          now,
        ),
      );
    }
    return outcomes;
  }

  private async importImageModel(
    providerId: string,
    m: PlannedImageModel,
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
        displayName: m.modelKey,
        supportedParameters: m.supportedParameters,
        inputModalities: m.constraints.maxReferences > 0 ? ['text', 'image'] : ['text'],
        outputModalities: ['image'],
        imageConstraints: { ...m.constraints },
        dataPolicyNotes: `Endpoint ${m.endpoint}. Requests send data_collection=deny; zdr per route.`,
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
            },
          });
      await tx.aiModelCapability.upsert({
        where: { modelId_capability: { modelId: model.id, capability: 'image_generation' } },
        create: { modelId: model.id, capability: 'image_generation' },
        update: {},
      });
      let newPrices = 0;
      const detail: string[] = [...m.warnings];
      for (const price of m.prices) {
        const latest = existing?.prices.find(
          (p) => p.metric === price.metric && p.variant === price.variant && p.effectiveFrom <= now,
        );
        if (latest && usdFromDecimal(latest.unitPrice).equals(price.unitPrice)) continue;
        await tx.aiModelPrice.create({
          data: {
            modelId: model.id,
            metric: price.metric,
            variant: price.variant,
            unitPrice: price.unitPrice.toString(),
            sourceValue: price.sourceValue,
            minPromptTokens: 0,
            effectiveFrom: now,
            source: 'official_api',
            sourceUrl,
            capturedAt: now,
          },
        });
        newPrices += 1;
        detail.push(
          `${price.metric}${price.variant ? ` [${price.variant}]` : ''}: ${latest ? `${usdFromDecimal(latest.unitPrice).toString()} → ` : ''}${price.sourceValue} USD (published)`,
        );
      }
      const action = !existing ? 'created' : newPrices > 0 ? 'updated' : 'unchanged';
      return { modelKey: m.modelKey, action, newPrices, detail };
    });
  }

  /**
   * Applies an OpenRouter video or TTS import plan (M5 design §3.3, §4.2). New models need a tier
   * and start disabled; a price row is appended only when the published value for that metric
   * and variant changed. Constraints are refreshed on every import.
   */
  async applyOpenRouterMediaImport(
    plan: readonly MediaPlanEntry[],
    options: { tier?: AiQualityTier; sourceUrl: (modelKey: string) => string; now?: Date },
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
      outcomes.push(
        entry.ok
          ? await this.importMediaModel(
              provider.id,
              entry.model,
              options.tier,
              options.sourceUrl(entry.modelKey),
              now,
            )
          : { modelKey: entry.modelKey, action: 'refused', newPrices: 0, detail: [entry.reason] },
      );
    }
    return outcomes;
  }

  private async importMediaModel(
    providerId: string,
    m: PlannedMediaModel,
    tier: AiQualityTier | undefined,
    sourceUrl: string,
    now: Date,
  ): Promise<ImportOutcome> {
    const capability = m.kind === 'video' ? ('video_generation' as const) : ('tts' as const);
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
        displayName: m.modelKey,
        supportedParameters: [],
        inputModalities: m.kind === 'video' ? ['text', 'image'] : ['text'],
        outputModalities: [m.kind === 'video' ? 'video' : 'speech'],
        // An operator-set minimum billed duration is not in the catalog: keep it on re-import.
        mediaConstraints: { ...m.constraints, ...keptMinimum(existing?.mediaConstraints) },
        dataPolicyNotes:
          m.kind === 'video'
            ? 'Requests send data_collection=deny. No video endpoint offers ZDR: the provider retains inputs and outputs briefly (verification record §1).'
            : 'Requests send data_collection=deny and zdr=true (decision V2).',
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
            },
          });
      await tx.aiModelCapability.upsert({
        where: { modelId_capability: { modelId: model.id, capability } },
        create: { modelId: model.id, capability },
        update: {},
      });
      let newPrices = 0;
      const detail: string[] = [...m.warnings];
      for (const price of m.prices) {
        const latest = existing?.prices.find(
          (p) => p.metric === price.metric && p.variant === price.variant && p.effectiveFrom <= now,
        );
        if (latest && usdFromDecimal(latest.unitPrice).equals(price.unitPrice)) continue;
        await tx.aiModelPrice.create({
          data: {
            modelId: model.id,
            metric: price.metric,
            variant: price.variant,
            unitPrice: price.unitPrice.toString(),
            sourceValue: price.sourceValue.slice(0, 64),
            minPromptTokens: 0,
            effectiveFrom: now,
            source: 'official_api',
            sourceUrl,
            capturedAt: now,
          },
        });
        newPrices += 1;
        detail.push(
          `${price.metric}${price.variant ? ` [${price.variant}]` : ''}: ${latest ? `${usdFromDecimal(latest.unitPrice).toString()} → ` : ''}${price.unitPrice.toString()} USD/unit (${price.sourceValue})`,
        );
      }
      const action = !existing ? 'created' : newPrices > 0 ? 'updated' : 'unchanged';
      return { modelKey: m.modelKey, action, newPrices, detail };
    });
  }
}

/** `{ minBilledSeconds }` of stored video constraints, if set. */
function keptMinimum(stored: unknown): { minBilledSeconds?: number } {
  const parsed = videoConstraintsSchema.safeParse(stored);
  return parsed.success && parsed.data.minBilledSeconds !== undefined
    ? { minBilledSeconds: parsed.data.minBilledSeconds }
    : {};
}
