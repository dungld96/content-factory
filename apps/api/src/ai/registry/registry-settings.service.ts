import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import {
  ApiErrorCode,
  aiModelSchema,
  type AiModelDto,
  type AiProviderKeyCheckDto,
  type AiProviderDto,
  type AiRouteDto,
  type AddAiModelPriceRequest,
  type AiTask,
  type ImportAiModelsRequest,
  type ImportAiModelsResponseDto,
  type SetAiRouteRequest,
  type SwitchAiGatewayRequest,
  type SwitchAiGatewayResponseDto,
  type UpdateAiModelRequest,
  type UpdateAiProviderRequest,
} from '@acf/contracts';
import type { KeyCheck, ModelListing } from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';

import type { Actor } from '../../auth/actor.js';
import { requireOperator } from '../../auth/operator.js';
import { ApiError } from '../../common/api-error.js';
import { notFound } from '../../common/domain-errors.js';
import { API_ENV } from '../../config/api-config.module.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { KEY_CHECKS, MODEL_LISTINGS } from '../ai.tokens.js';
import { catalogUrl, planOpenRouterImport } from '../providers/openrouter-catalog.js';
import {
  imageEndpointsUrl,
  planOpenRouterImageImport,
} from '../providers/openrouter-image-catalog.js';
import {
  planOpenRouterTtsImport,
  planOpenRouterVideoImport,
} from '../providers/openrouter-media-catalog.js';
import {
  MIXROUTE_CATALOG_CHECKED_AT,
  MIXROUTE_CATALOG_KEYS,
  type MixRouteAvailability,
  mixRouteSourceUrl,
  planMixRouteImageImport,
  planMixRouteTextImport,
} from '../providers/mixroute-catalog.js';
import {
  GatewayChoiceError,
  planGatewaySwitch,
  type CurrentRoute,
  type GatewayModel,
  type TaskSwitchPlan,
} from './gateway-switch.js';
import {
  MIXROUTE_PROVIDER_ROW,
  RegistryAdminError,
  RegistryAdminService,
  supportsZeroDataRetention,
  type ImportOutcome,
} from './registry-admin.service.js';
import { ROUTED_TASKS, RegistryService } from './registry.service.js';

/** The capability a task's model must have. */
const TASK_CAPABILITY: Readonly<Record<AiTask, string>> = {
  script_generation: 'llm',
  storyboard_generation: 'llm',
  image_generation: 'image_generation',
  video_generation: 'video_generation',
  tts_generation: 'tts',
};

const notRoutable = (message: string) =>
  new ApiError({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.ModelNotRoutable,
    message,
  });

/**
 * Registry changes by platform operators over HTTP (P1 design O1, O4, O5). Every write goes
 * through {@link RegistryAdminService}, the same code as the operator CLI, and is audited.
 */
@Injectable()
export class RegistrySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RegistryService,
    private readonly admin: RegistryAdminService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(KEY_CHECKS) private readonly keyChecks: ReadonlyMap<string, KeyCheck>,
    @Inject(MODEL_LISTINGS) private readonly listings: ReadonlyMap<string, ModelListing>,
  ) {}

  async setRoute(actor: Actor, task: AiTask, input: SetAiRouteRequest): Promise<AiRouteDto> {
    requireOperator(this.env, actor);
    const capability = TASK_CAPABILITY[task];
    const models = await this.prisma.client.aiModel.findMany({
      where: {
        modelKey: input.modelKey,
        ...(input.providerKey ? { provider: { key: input.providerKey } } : {}),
      },
      include: { provider: true, capabilities: true },
    });
    if (models.length === 0) throw notFound('model');
    if (models.length > 1) {
      throw notRoutable(`${input.modelKey} exists at several providers: name the provider.`);
    }
    const model = models[0];
    if (!model) throw notFound('model');
    if (!model.capabilities.some((c) => c.capability === capability)) {
      throw notRoutable(`${model.modelKey} has no ${capability} capability.`);
    }
    if (model.status !== 'enabled' || model.provider.status !== 'enabled') {
      throw notRoutable('Enable the model and its provider before routing to it.');
    }
    if (!this.registry.isConfiguredFor(capability, model.provider.key)) {
      throw notRoutable(`${model.provider.key} has no credentials in this deployment.`);
    }
    // Registry rules (e.g. zero-data-retention on MixRoute, P5) become 422.
    await this.wrap(async () => {
      await this.admin.setRoute(
        task,
        model.provider.key,
        model.modelKey,
        input.zeroDataRetention ?? false,
        { actorId: actor.userId },
      );
    });
    const routes = await this.registry.listRoutes();
    const route = routes.data.find((r) => r.task === task);
    if (!route) throw notFound('route');
    return route;
  }

  async updateProvider(
    actor: Actor,
    providerKey: string,
    input: UpdateAiProviderRequest,
  ): Promise<AiProviderDto> {
    requireOperator(this.env, actor);
    const exists = await this.prisma.client.aiProvider.findUnique({ where: { key: providerKey } });
    if (!exists) throw notFound('provider');
    await this.wrap(() =>
      this.admin.setProviderStatus(providerKey, input.status, { actorId: actor.userId }),
    );
    const provider = (await this.registry.listProviders()).data.find((p) => p.key === providerKey);
    if (!provider) throw notFound('provider');
    return provider;
  }

  async updateModel(
    actor: Actor,
    modelId: string,
    input: UpdateAiModelRequest,
  ): Promise<AiModelDto> {
    requireOperator(this.env, actor);
    const model = await this.prisma.client.aiModel.findUnique({
      where: { id: modelId },
      include: { provider: true },
    });
    if (!model) throw notFound('model');
    const by = { actorId: actor.userId };
    if (input.schemaMode !== undefined) {
      await this.wrap(() =>
        this.admin.setSchemaMode(
          model.provider.key,
          model.modelKey,
          input.schemaMode ?? 'full',
          by,
        ),
      );
    }
    if (input.status !== undefined) {
      await this.wrap(() =>
        this.admin.setModelStatus(
          model.provider.key,
          model.modelKey,
          input.status ?? 'disabled',
          by,
        ),
      );
    }
    const detail = await this.registry.getModel(modelId);
    return aiModelSchema.parse(detail);
  }

  /** Free credential check (P1 O3): never a paid call, never the key in the answer. */
  async testProvider(actor: Actor, providerKey: string): Promise<AiProviderKeyCheckDto> {
    requireOperator(this.env, actor);
    const provider = await this.prisma.client.aiProvider.findUnique({
      where: { key: providerKey },
    });
    if (!provider) throw notFound('provider');
    const check = this.keyChecks.get(providerKey);
    const checkedAt = new Date().toISOString();
    if (!check) {
      return {
        providerKey,
        result: 'not_configured',
        httpStatus: null,
        limitRemaining: null,
        usage: null,
        isFreeTier: null,
        checkedAt,
      };
    }
    return { providerKey, ...(await check()), checkedAt };
  }

  /**
   * P1d: previews or applies an OpenRouter catalog import (operators), through the same planning
   * and writing code as `pnpm ai:registry model import-openrouter*`. Reads only the public
   * catalog (no key, no cost). New models are created disabled; prices are appended.
   */
  async importModels(
    actor: Actor,
    input: ImportAiModelsRequest,
  ): Promise<ImportAiModelsResponseDto> {
    requireOperator(this.env, actor);
    if (input.gateway === 'mixroute') return this.importMixRouteModels(actor, input);
    const baseUrl = this.env.OPENROUTER_BASE_URL;
    const keys = [...new Set(input.modelKeys)];
    const by = { actorId: actor.userId };
    const tier = input.tier ? { tier: input.tier } : {};
    type Preview = {
      modelKey: string;
      ok: boolean;
      summary: string | null;
      warnings: string[];
      reason: string | null;
    };
    let previews: Preview[];
    let apply: () => Promise<ImportOutcome[]>;
    try {
      switch (input.catalog) {
        case 'llm': {
          const plan = await planOpenRouterImport(baseUrl, keys);
          previews = plan.map((e) =>
            e.ok
              ? {
                  modelKey: e.modelKey,
                  ok: true,
                  summary: `${e.model.prices.map((p) => `${p.metric}${p.minPromptTokens ? `≥${String(p.minPromptTokens)}` : ''} = ${p.sourceValue}`).join(', ')}; parameters: ${e.model.supportedParameters.join(', ')}`,
                  warnings: [...e.model.warnings],
                  reason: null,
                }
              : { modelKey: e.modelKey, ok: false, summary: null, warnings: [], reason: e.reason },
          );
          apply = () =>
            this.admin.applyOpenRouterImport(plan, { ...tier, sourceUrl: catalogUrl(baseUrl), by });
          break;
        }
        case 'image': {
          const plan = await planOpenRouterImageImport(baseUrl, keys);
          previews = plan.map((e) =>
            e.ok
              ? {
                  modelKey: e.modelKey,
                  ok: true,
                  summary: `${e.model.prices.map((p) => `${p.metric}${p.variant ? ` [${p.variant}]` : ''} = ${p.sourceValue}`).join(', ')}; up to ${String(e.model.constraints.maxImages)} image(s), ${String(e.model.constraints.maxReferences)} reference(s); ratios ${e.model.constraints.aspectRatios.join(', ')}`,
                  warnings: [...e.model.warnings],
                  reason: null,
                }
              : { modelKey: e.modelKey, ok: false, summary: null, warnings: [], reason: e.reason },
          );
          apply = () =>
            this.admin.applyOpenRouterImageImport(plan, {
              ...tier,
              sourceUrl: (key) => imageEndpointsUrl(baseUrl, key),
              by,
            });
          break;
        }
        case 'video':
        case 'tts': {
          const video = input.catalog === 'video';
          const plan = video
            ? await planOpenRouterVideoImport(baseUrl, keys)
            : await planOpenRouterTtsImport(baseUrl, keys);
          previews = plan.map((e) => {
            if (!e.ok) {
              return {
                modelKey: e.modelKey,
                ok: false,
                summary: null,
                warnings: [],
                reason: e.reason,
              };
            }
            const c = e.model.constraints;
            const prices =
              e.model.prices
                .map(
                  (p) =>
                    `${p.metric}${p.variant ? ` [${p.variant}]` : ''} = ${p.unitPrice.toString()}`,
                )
                .join(', ') || 'no published prices';
            const limits =
              c.kind === 'video'
                ? `durations ${c.durations.join(', ')} s; resolutions ${c.resolutions.join(', ')}`
                : `${String(c.voices.length)} voice(s); ${c.mp3 ? 'MP3' : 'PCM only'}`;
            return {
              modelKey: e.modelKey,
              ok: true,
              summary: `${prices}; ${limits}`,
              warnings: [...e.model.warnings],
              reason: null,
            };
          });
          const base = baseUrl.replace(/\/+$/, '');
          apply = () =>
            this.admin.applyOpenRouterMediaImport(plan, {
              ...tier,
              sourceUrl: () =>
                video ? `${base}/videos/models` : `${base}/models?output_modalities=speech`,
              by,
            });
          break;
        }
      }
    } catch (error) {
      throw new ApiError({
        status: HttpStatus.BAD_GATEWAY,
        code: ApiErrorCode.CatalogUnavailable,
        message: `The OpenRouter catalog could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
    if (!input.apply) {
      return {
        applied: false,
        entries: previews.map((p) => ({ ...p, action: null, newPrices: null, detail: [] })),
      };
    }
    let outcomes: ImportOutcome[] = [];
    await this.wrap(async () => {
      outcomes = await apply();
    });
    return {
      applied: true,
      entries: previews.map((p) => {
        const o = outcomes.find((x) => x.modelKey === p.modelKey);
        return {
          ...p,
          action: o?.action ?? null,
          newPrices: o?.newPrices ?? null,
          detail: o ? [...o.detail] : [],
        };
      }),
    };
  }

  /**
   * P5: previews or applies an import from MixRoute's curated catalog (text and image models;
   * prices from the official model pages). No network call: MixRoute publishes no price API.
   */
  private async importMixRouteModels(
    actor: Actor,
    input: ImportAiModelsRequest,
  ): Promise<ImportAiModelsResponseDto> {
    if (input.catalog !== 'llm' && input.catalog !== 'image') {
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.ValidationFailed,
        message: 'MixRoute video and voice models are not available yet (P5b).',
      });
    }
    const keys = [...new Set(input.modelKeys)];
    const by = { actorId: actor.userId };
    const tier = input.tier ? { tier: input.tier } : {};
    const common = {
      ...tier,
      by,
      provider: MIXROUTE_PROVIDER_ROW,
      priceSource: 'official_page' as const,
    };
    // Ids are checked against what MixRoute offers this key (free GET /models): uncurated ones
    // must be listed; verified ones get a warning when they are not.
    const curated: readonly string[] =
      input.catalog === 'llm' ? MIXROUTE_CATALOG_KEYS.llm : MIXROUTE_CATALOG_KEYS.image;
    let available: MixRouteAvailability = null;
    const listing = this.listings.get(MIXROUTE_PROVIDER_ROW.key);
    if (listing) {
      try {
        available = new Set(await listing());
      } catch {
        available = null; // the preview says the list could not be read
      }
    }
    const text = input.catalog === 'llm' ? planMixRouteTextImport(keys, available) : [];
    const image = input.catalog === 'image' ? planMixRouteImageImport(keys, available) : [];
    const previews = [...text, ...image].map((e) => {
      if (!e.ok) {
        return { modelKey: e.modelKey, ok: false, summary: null, warnings: [], reason: e.reason };
      }
      const prices = e.model.prices
        .map((p) => {
          const tierNote =
            'minPromptTokens' in p && p.minPromptTokens > 0
              ? ` (≥${String(p.minPromptTokens)} prompt tokens)`
              : '';
          return `${p.metric}${tierNote} = ${p.sourceValue}`;
        })
        .join(', ');
      return {
        modelKey: e.modelKey,
        ok: true,
        summary: curated.includes(e.modelKey)
          ? `${prices}; source ${mixRouteSourceUrl(e.modelKey)} (checked ${MIXROUTE_CATALOG_CHECKED_AT})`
          : `offered by MixRoute for this key; no price recorded; see ${mixRouteSourceUrl(e.modelKey)}`,
        warnings: [...e.model.warnings],
        reason: null,
      };
    });
    if (!input.apply) {
      return {
        applied: false,
        entries: previews.map((p) => ({ ...p, action: null, newPrices: null, detail: [] })),
      };
    }
    const outcomes: ImportOutcome[] = [];
    await this.wrap(async () => {
      // One call per model: each carries its own source page.
      for (const entry of text) {
        outcomes.push(
          ...(await this.admin.applyOpenRouterImport([entry], {
            ...common,
            sourceUrl: mixRouteSourceUrl(entry.modelKey),
          })),
        );
      }
      if (image.length > 0) {
        outcomes.push(
          ...(await this.admin.applyOpenRouterImageImport(image, {
            ...common,
            sourceUrl: mixRouteSourceUrl,
            dataPolicyNotes: () =>
              'MixRoute: request content passes through memory only (data-security FAQ); the upstream provider applies its own policy. No ZDR routing.',
          })),
        );
      }
    });
    return {
      applied: true,
      entries: previews.map((p) => {
        const o = outcomes.find((x) => x.modelKey === p.modelKey);
        return {
          ...p,
          action: o?.action ?? null,
          newPrices: o?.newPrices ?? null,
          detail: o ? [...o.detail] : [],
        };
      }),
    };
  }

  /**
   * P5 (decision G6): moves every task to one gateway. Preview suggests the equivalent model per
   * task; apply routes all chosen tasks in one transaction, with the same rules as
   * `PUT /ai/routes/:task` (enabled model and provider, configured, capability). Tasks without a
   * routable model, or whose route needs zero-data-retention the gateway lacks, stay where they are.
   */
  async switchGateway(
    actor: Actor,
    providerKey: string,
    input: SwitchAiGatewayRequest,
  ): Promise<SwitchAiGatewayResponseDto> {
    requireOperator(this.env, actor);
    const provider = await this.prisma.client.aiProvider.findUnique({
      where: { key: providerKey },
    });
    if (!provider) throw notFound('provider');
    if (provider.kind !== 'gateway') throw notRoutable(`${providerKey} is not a gateway.`);

    const routeRows = await this.prisma.client.aiTaskRoute.findMany({
      include: { model: { include: { provider: true } } },
    });
    const routes = new Map<AiTask, CurrentRoute>();
    for (const r of routeRows) {
      routes.set(r.task as AiTask, {
        providerKey: r.model.provider.key,
        modelKey: r.model.modelKey,
        displayName: r.model.displayName,
        zeroDataRetention: r.zeroDataRetention,
      });
    }
    const models =
      provider.status === 'enabled'
        ? await this.prisma.client.aiModel.findMany({
            where: { providerId: provider.id, status: 'enabled' },
            include: { capabilities: true },
            orderBy: { modelKey: 'asc' },
          })
        : [];
    const candidates = new Map<AiTask, GatewayModel[]>();
    for (const task of ROUTED_TASKS) {
      const capability = TASK_CAPABILITY[task];
      candidates.set(
        task,
        this.registry.isConfiguredFor(capability, providerKey)
          ? models
              .filter((m) => m.capabilities.some((c) => c.capability === capability))
              .map((m) => ({ modelKey: m.modelKey, displayName: m.displayName }))
          : [],
      );
    }
    let plan: TaskSwitchPlan[];
    try {
      plan = planGatewaySwitch({
        providerKey,
        supportsZeroDataRetention: supportsZeroDataRetention(providerKey),
        tasks: ROUTED_TASKS,
        routes,
        candidates,
        ...(input.choices ? { choices: input.choices } : {}),
      });
    } catch (error) {
      if (error instanceof GatewayChoiceError) throw notRoutable(error.message);
      throw error;
    }
    const switching = plan.filter((p) => p.target !== null);
    if (input.apply && switching.length > 0) {
      await this.wrap(async () => {
        await this.admin.setRoutes(
          switching.map((p) => ({
            task: p.task,
            providerKey,
            modelKey: p.target?.modelKey ?? '',
            zeroDataRetention: false,
          })),
          { actorId: actor.userId },
        );
      });
    }
    return {
      providerKey,
      applied: input.apply,
      tasks: plan.map((p) => ({
        task: p.task,
        current: p.current
          ? {
              providerKey: p.current.providerKey,
              modelKey: p.current.modelKey,
              displayName: p.current.displayName,
            }
          : null,
        candidates: [...p.candidates],
        target: p.target,
        keptBecause: p.keptBecause,
        action: input.apply ? (p.target ? 'switched' : 'kept') : null,
      })),
    };
  }

  /** P1d: appends a price row to a model (operators); existing rows are never changed. */
  async addPrice(
    actor: Actor,
    modelId: string,
    input: AddAiModelPriceRequest,
  ): Promise<AiModelDto> {
    requireOperator(this.env, actor);
    const model = await this.prisma.client.aiModel.findUnique({
      where: { id: modelId },
      include: { provider: { select: { key: true } } },
    });
    if (!model) throw notFound('model');
    await this.wrap(async () => {
      await this.admin.addPrice(
        {
          providerKey: model.provider.key,
          modelKey: model.modelKey,
          metric: input.metric,
          usdPerUnit: input.usdPerUnit,
          source: input.source,
          sourceUrl: input.sourceUrl,
          ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
          ...(input.minPromptTokens === undefined
            ? {}
            : { minPromptTokens: input.minPromptTokens }),
        },
        { actorId: actor.userId },
      );
    });
    return aiModelSchema.parse(await this.registry.getModel(modelId));
  }

  /** Registry rule violations (unknown provider, not a text model) become `422`. */
  private async wrap(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof RegistryAdminError) {
        throw new ApiError({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ApiErrorCode.ModelNotRoutable,
          message: error.message,
        });
      }
      throw error;
    }
  }
}
