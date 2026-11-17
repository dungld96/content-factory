import { Controller, Get } from '@nestjs/common';
import type { z } from 'zod';

import {
  aiModelDetailSchema,
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

import { Endpoint, ValidParams, ValidQuery } from '../../common/http/endpoint.js';
import { RegistryService } from './registry.service.js';

/**
 * Read-only registry (design package §8.2, decision E3). Any authenticated user; registry data
 * is not project-scoped. Writes happen only through the operator CLI (`pnpm ai:registry`).
 */
@Controller('ai')
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

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
}
