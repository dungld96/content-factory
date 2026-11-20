import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import {
  ApiErrorCode,
  aiModelSchema,
  type AiModelDto,
  type AiProviderDto,
  type AiRouteDto,
  type AiTask,
  type SetAiRouteRequest,
  type UpdateAiModelRequest,
  type UpdateAiProviderRequest,
} from '@acf/contracts';
import type { ApiEnv } from '@acf/config';

import type { Actor } from '../../auth/actor.js';
import { requireOperator } from '../../auth/operator.js';
import { ApiError } from '../../common/api-error.js';
import { notFound } from '../../common/domain-errors.js';
import { API_ENV } from '../../config/api-config.module.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { RegistryAdminError, RegistryAdminService } from './registry-admin.service.js';
import { RegistryService } from './registry.service.js';

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
    await this.admin.setRoute(
      task,
      model.provider.key,
      model.modelKey,
      input.zeroDataRetention ?? false,
      { actorId: actor.userId },
    );
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
