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

/** MixRoute gateway row (P5; docs/design/p5/mixroute-verification.md). */
export const MIXROUTE_PROVIDER_ROW = {
  key: 'mixroute',
  name: 'MixRoute',
  kind: 'gateway',
  termsUrl: 'https://mixroute.ai/docs/service-term',
  dataPolicyUrl: 'https://mixroute.ai/docs/faq/data-security',
  notes:
    'OpenAI-compatible gateway (text, Seedream images in P5a). Reports no per-call cost: calls are recorded at the registry estimate. No per-request zero-data-retention routing; upstream providers apply their own data policies.',
} as const;

/**
 * Gateways that can restrict a call to zero-data-retention endpoints (M4 decision G9). MixRoute
 * cannot (P5 decision G5): a ZDR route never moves to it.
 */
export function supportsZeroDataRetention(providerKey: string): boolean {
  return providerKey !== MIXROUTE_PROVIDER_ROW.key;
}

/** A gateway's registry row, created disabled on first import. */
export interface ProviderRow {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly termsUrl: string;
  readonly dataPolicyUrl: string;
  readonly notes: string;
}

/** Who made a registry change (P1 O6): an operator over HTTP; omitted for the CLI. */
export interface RegistryChangeBy {
  readonly actorId: string;
}

type RegistryAction =
  | 'provider_status'
  | 'model_status'
  | 'model_schema_mode'
  | 'model_min_billed_seconds'
  | 'route_set'
  | 'price_added'
  | 'model_imported';

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

  /** One `model_imported` event per model an import created or changed (CLI or operator, P1d). */
  private async recordImports(
    outcomes: readonly ImportOutcome[],
    by?: RegistryChangeBy,
  ): Promise<void> {
    for (const o of outcomes) {
      if (o.action === 'created' || o.action === 'updated' || o.newPrices > 0) {
        await this.record(this.prisma, by, 'model_imported', o.modelKey, null, {
          action: o.action,
          newPrices: o.newPrices,
        });
      }
    }
  }

  /** Appends one audit row (append-only, AC011) in the caller's transaction. */
  private async record(
    tx: Prisma.TransactionClient | PrismaClient,
    by: RegistryChangeBy | undefined,
    action: RegistryAction,
    target: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await tx.aiRegistryEvent.create({
      data: {
        actorId: by?.actorId ?? null,
        source: by ? 'api' : 'cli',
        action,
        target,
        ...(before === null ? {} : { before }),
        ...(after === null ? {} : { after }),
      },
    });
  }

  async setProviderStatus(
    key: string,
    status: AiProviderStatus,
    by?: RegistryChangeBy,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiProvider.findUnique({ where: { key }, select: { status: true } });
      if (!row) throw new RegistryAdminError(`unknown provider ${key}`);
      await tx.aiProvider.update({ where: { key }, data: { status } });
      await this.record(tx, by, 'provider_status', key, { status: row.status }, { status });
    });
  }

  async setModelStatus(
    providerKey: string,
    modelKey: string,
    status: AiProviderStatus,
    by?: RegistryChangeBy,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiModel.findFirst({
        where: { modelKey, provider: { key: providerKey } },
        select: { id: true, status: true },
      });
      if (!row) throw new RegistryAdminError(`unknown model ${providerKey}/${modelKey}`);
      await tx.aiModel.update({ where: { id: row.id }, data: { status } });
      await this.record(
        tx,
        by,
        'model_status',
        `${providerKey}/${modelKey}`,
        { status: row.status },
        { status },
      );
    });
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
    by?: RegistryChangeBy,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.aiModel.findFirst({
        where: {
          modelKey,
          provider: { key: providerKey },
          capabilities: { some: { capability: 'llm' } },
        },
        select: { id: true, schemaMode: true },
      });
      if (!row)
        throw new RegistryAdminError(`${providerKey}/${modelKey} is not a registered text model`);
      await tx.aiModel.update({ where: { id: row.id }, data: { schemaMode: mode } });
      await this.record(
        tx,
        by,
        'model_schema_mode',
        `${providerKey}/${modelKey}`,
        { schemaMode: row.schemaMode },
        { schemaMode: mode },
      );
    });
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
    await this.prisma.$transaction(async (tx) => {
      await tx.aiModel.update({
        where: { id: model.id },
        data: { mediaConstraints: next as Prisma.InputJsonObject },
      });
      await this.record(
        tx,
        undefined,
        'model_min_billed_seconds',
        `${providerKey}/${modelKey}`,
        { minBilledSeconds: parsed.data.minBilledSeconds ?? null },
        { minBilledSeconds: seconds },
      );
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
    by?: RegistryChangeBy,
  ): Promise<{ enabled: boolean }> {
    const [result] = await this.setRoutes([{ task, providerKey, modelKey, zeroDataRetention }], by);
    return result ?? { enabled: false };
  }

  /**
   * Routes several tasks in ONE transaction (P5 gateway switch): every entry is checked first,
   * then all routes change together, each with its own `route_set` event.
   */
  async setRoutes(
    entries: readonly {
      task: GenerationJobKind;
      providerKey: string;
      modelKey: string;
      zeroDataRetention: boolean;
    }[],
    by?: RegistryChangeBy,
  ): Promise<{ enabled: boolean }[]> {
    type RouteModel = Prisma.AiModelGetPayload<{ include: { capabilities: true; provider: true } }>;
    const checked: ((typeof entries)[number] & { model: RouteModel })[] = [];
    for (const entry of entries) {
      const { task, providerKey, modelKey, zeroDataRetention } = entry;
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
      if (zeroDataRetention && !supportsZeroDataRetention(providerKey)) {
        throw new RegistryAdminError(
          `${providerKey} cannot restrict calls to zero-data-retention endpoints`,
        );
      }
      checked.push({ ...entry, model });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const { task, providerKey, modelKey, zeroDataRetention, model } of checked) {
        const before = await tx.aiTaskRoute.findUnique({
          where: { task },
          include: { model: { select: { modelKey: true } } },
        });
        await tx.aiTaskRoute.upsert({
          where: { task },
          create: { task, modelId: model.id, zeroDataRetention },
          update: { modelId: model.id, zeroDataRetention },
        });
        await this.record(
          tx,
          by,
          'route_set',
          task,
          before
            ? { modelKey: before.model.modelKey, zeroDataRetention: before.zeroDataRetention }
            : null,
          { modelKey: `${providerKey}/${modelKey}`, zeroDataRetention },
        );
      }
    });
    return checked.map(({ model }) => ({
      enabled: model.status === 'enabled' && model.provider.status === 'enabled',
    }));
  }

  async addPrice(
    input: {
      providerKey: string;
      modelKey: string;
      metric: PriceMetric;
      usdPerUnit: string;
      source: AiPriceSource;
      sourceUrl: string;
      effectiveFrom?: Date;
      minPromptTokens?: number;
    },
    by?: RegistryChangeBy,
  ): Promise<string> {
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
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.aiModelPrice.create({
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
      await this.record(tx, by, 'price_added', `${input.providerKey}/${input.modelKey}`, null, {
        priceId: row.id,
        metric: input.metric,
        usdPerUnit: input.usdPerUnit.trim(),
        source: input.source,
      });
      return row.id;
    });
  }

  /**
   * Applies an OpenRouter import plan. New models need a quality tier and start disabled;
   * existing models keep their status and tier. A price row is appended only when the published
   * value differs from the latest row for that metric and tier.
   */
  async applyOpenRouterImport(
    plan: readonly ImportPlanEntry[],
    options: {
      tier?: AiQualityTier;
      sourceUrl: string;
      now?: Date;
      by?: RegistryChangeBy;
      /** Default OpenRouter (P5: also MixRoute's curated catalog). */
      provider?: ProviderRow;
      /** Default `official_api` (a catalog API); `official_page` for a published price page. */
      priceSource?: AiPriceSource;
    },
  ): Promise<ImportOutcome[]> {
    const now = options.now ?? new Date();
    const provider = await this.upsertProvider(options.provider ?? OPENROUTER_PROVIDER_ROW);
    const priceSource = options.priceSource ?? 'official_api';
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
        await this.importModel(
          provider.id,
          entry.model,
          options.tier,
          options.sourceUrl,
          now,
          priceSource,
        ),
      );
    }
    await this.recordImports(outcomes, options.by);
    return outcomes;
  }

  private async upsertProvider(row: ProviderRow): Promise<{ id: string }> {
    return this.prisma.aiProvider.upsert({
      where: { key: row.key },
      create: { ...row, status: 'disabled' },
      update: {},
      select: { id: true },
    });
  }

  private async importModel(
    providerId: string,
    m: PlannedModel,
    tier: AiQualityTier | undefined,
    sourceUrl: string,
    now: Date,
    priceSource: AiPriceSource,
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
            source: priceSource,
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
    options: {
      tier?: AiQualityTier;
      sourceUrl: (modelKey: string) => string;
      now?: Date;
      by?: RegistryChangeBy;
      /** Default OpenRouter (P5: also MixRoute's curated catalog). */
      provider?: ProviderRow;
      priceSource?: AiPriceSource;
      /** Default: the OpenRouter endpoint note. */
      dataPolicyNotes?: (m: PlannedImageModel) => string;
    },
  ): Promise<ImportOutcome[]> {
    const now = options.now ?? new Date();
    const provider = await this.upsertProvider(options.provider ?? OPENROUTER_PROVIDER_ROW);
    const writeOptions = {
      priceSource: options.priceSource ?? ('official_api' as const),
      dataPolicyNotes:
        options.dataPolicyNotes ??
        ((m: PlannedImageModel) =>
          `Endpoint ${m.endpoint}. Requests send data_collection=deny; zdr per route.`),
    };
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
          writeOptions,
        ),
      );
    }
    await this.recordImports(outcomes, options.by);
    return outcomes;
  }

  private async importImageModel(
    providerId: string,
    m: PlannedImageModel,
    tier: AiQualityTier | undefined,
    sourceUrl: string,
    now: Date,
    options: {
      priceSource: AiPriceSource;
      dataPolicyNotes: (m: PlannedImageModel) => string;
    },
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
        dataPolicyNotes: options.dataPolicyNotes(m),
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
            source: options.priceSource,
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
    options: {
      tier?: AiQualityTier;
      sourceUrl: (modelKey: string) => string;
      now?: Date;
      by?: RegistryChangeBy;
    },
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
    await this.recordImports(outcomes, options.by);
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
