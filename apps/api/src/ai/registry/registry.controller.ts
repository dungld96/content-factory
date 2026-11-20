import { Controller, Get, Inject, Patch, Put } from '@nestjs/common';
import type { ApiEnv } from '@acf/config';
import type { z } from 'zod';

import {
  aiModelDetailSchema,
  aiProviderKeyParamsSchema,
  aiProviderSchema,
  aiRegistryEventSchema,
  aiRouteListSchema,
  aiRouteSchema,
  aiTaskParamsSchema,
  paginationQuerySchema,
  setAiRouteRequestSchema,
  updateAiModelRequestSchema,
  updateAiProviderRequestSchema,
  type AiProviderDto,
  type AiRegistryEventDto,
  type AiRouteDto,
  type AiRouteList,
  type SetAiRouteRequest,
  type UpdateAiModelRequest,
  type UpdateAiProviderRequest,
  aiModelIdParamsSchema,
  aiModelSchema,
  aiProviderListSchema,
  listAiModelsQuerySchema,
  pageSchema,
  type AiModelDetailDto,
  type AiModelDto,
  type AiProviderList,
  type Page,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../../auth/actor.js';
import { requireOperator } from '../../auth/operator.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../../common/http/endpoint.js';
import { API_ENV } from '../../config/api-config.module.js';
import { RegistrySettingsService } from './registry-settings.service.js';
import { RegistryService } from './registry.service.js';

/**
 * Read-only registry (design package §8.2, decision E3). Any authenticated user; registry data
 * is not project-scoped. Writes happen only through the operator CLI (`pnpm ai:registry`).
 */
@Controller('ai')
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    private readonly settings: RegistrySettingsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get('providers')
  @Endpoint({
    summary: 'List AI providers (credentials are never exposed)',
    tags: ['ai'],
    responses: { 200: { description: 'Providers', schema: aiProviderListSchema } },
    errors: [401],
  })
  providers(): Promise<AiProviderList> {
    return this.registry.listProviders();
  }

  @Get('models')
  @Endpoint({
    summary: 'List AI models with their active prices',
    tags: ['ai'],
    query: listAiModelsQuerySchema,
    responses: { 200: { description: 'Page of models', schema: pageSchema(aiModelSchema) } },
    errors: [400, 401],
  })
  models(@ValidQuery() query: z.output<typeof listAiModelsQuerySchema>): Promise<Page<AiModelDto>> {
    return this.registry.listModels(query);
  }

  @Get('models/:modelId')
  @Endpoint({
    summary: 'Get an AI model with its price history',
    tags: ['ai'],
    params: aiModelIdParamsSchema,
    responses: { 200: { description: 'The model', schema: aiModelDetailSchema } },
    errors: [400, 401, 404],
  })
  model(@ValidParams() params: z.infer<typeof aiModelIdParamsSchema>): Promise<AiModelDetailDto> {
    return this.registry.getModel(params.modelId);
  }

  // ----------------------------------------------------------------- P1: operator settings

  @Get('routes')
  @Endpoint({
    summary: 'Every generation task and the model it is routed to',
    tags: ['ai'],
    responses: { 200: { description: 'Routes', schema: aiRouteListSchema } },
    errors: [401],
  })
  routes(): Promise<AiRouteList> {
    return this.registry.listRoutes();
  }

  @Put('routes/:task')
  @Endpoint({
    summary: 'Route a generation task to an enabled, configured model (operators)',
    tags: ['ai'],
    params: aiTaskParamsSchema,
    body: setAiRouteRequestSchema,
    responses: { 200: { description: 'The route', schema: aiRouteSchema } },
    errors: [400, 401, 403, 404, 422],
  })
  setRoute(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof aiTaskParamsSchema>,
    @ValidBody() body: SetAiRouteRequest,
  ): Promise<AiRouteDto> {
    return this.settings.setRoute(actor, params.task, body);
  }

  @Patch('providers/:providerKey')
  @Endpoint({
    summary: "Change a provider's status (operators)",
    tags: ['ai'],
    params: aiProviderKeyParamsSchema,
    body: updateAiProviderRequestSchema,
    responses: { 200: { description: 'The provider', schema: aiProviderSchema } },
    errors: [400, 401, 403, 404, 422],
  })
  updateProvider(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof aiProviderKeyParamsSchema>,
    @ValidBody() body: UpdateAiProviderRequest,
  ): Promise<AiProviderDto> {
    return this.settings.updateProvider(actor, params.providerKey, body);
  }

  @Patch('models/:modelId')
  @Endpoint({
    summary: "Change a model's status or structured-output mode (operators)",
    tags: ['ai'],
    params: aiModelIdParamsSchema,
    body: updateAiModelRequestSchema,
    responses: { 200: { description: 'The model', schema: aiModelSchema } },
    errors: [400, 401, 403, 404, 422],
  })
  updateModel(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof aiModelIdParamsSchema>,
    @ValidBody() body: UpdateAiModelRequest,
  ): Promise<AiModelDto> {
    return this.settings.updateModel(actor, params.modelId, body);
  }

  @Get('registry-events')
  @Endpoint({
    summary: 'The AI registry audit, newest first (operators)',
    tags: ['ai'],
    query: paginationQuerySchema,
    responses: {
      200: { description: 'Page of events', schema: pageSchema(aiRegistryEventSchema) },
    },
    errors: [400, 401, 403],
  })
  events(
    @CurrentActor() actor: Actor,
    @ValidQuery() query: z.output<typeof paginationQuerySchema>,
  ): Promise<Page<AiRegistryEventDto>> {
    requireOperator(this.env, actor);
    return this.registry.listEvents(query);
  }
}
