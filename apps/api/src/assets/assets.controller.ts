import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  assetIdParamsSchema,
  assetSchema,
  assetUsageSchema,
  lineageQuerySchema,
  lineageResponseSchema,
  listAssetsQuerySchema,
  listSchema,
  pageSchema,
  projectIdParamsSchema,
  registerAssetRequestSchema,
  updateAssetRequestSchema,
  type AssetDto,
  type AssetUsageDto,
  type LineageResponse,
  type Page,
  type RegisterAssetRequest,
  type UpdateAssetRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { AssetsService } from './assets.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type AssetParams = z.infer<typeof assetIdParamsSchema>;
const tags = ['assets'];

@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('projects/:projectId/assets')
  @Endpoint({
    summary: 'Register asset metadata (editor); the storage key must be under the project',
    tags,
    params: projectIdParamsSchema,
    body: registerAssetRequestSchema,
    responses: { 201: { description: 'Registered', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  register(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: RegisterAssetRequest,
  ): Promise<AssetDto> {
    return this.assets.register(actor, params.projectId, body);
  }

  @Get('projects/:projectId/assets')
  @Endpoint({
    summary: 'List assets',
    tags,
    params: projectIdParamsSchema,
    query: listAssetsQuerySchema,
    responses: { 200: { description: 'Page of assets', schema: pageSchema(assetSchema) } },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.output<typeof listAssetsQuerySchema>,
  ): Promise<Page<AssetDto>> {
    return this.assets.list(actor, params.projectId, query);
  }

  @Get('assets/:assetId')
  @Endpoint({
    summary: 'Get an asset',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'The asset', schema: assetSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.assets.get(actor, params.assetId);
  }

  @Get('assets/:assetId/lineage')
  @Endpoint({
    summary: 'Ancestors or descendants of an asset',
    tags,
    params: assetIdParamsSchema,
    query: lineageQuerySchema,
    responses: { 200: { description: 'Lineage', schema: lineageResponseSchema } },
    errors: [400, 401, 404],
  })
  lineage(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
    @ValidQuery() query: z.output<typeof lineageQuerySchema>,
  ): Promise<LineageResponse> {
    return this.assets.lineage(actor, params.assetId, query);
  }

  @Get('assets/:assetId/usages')
  @Endpoint({
    summary: 'Character and environment versions that reference the asset',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Usages', schema: listSchema(assetUsageSchema) } },
    errors: [400, 401, 404],
  })
  usages(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
  ): Promise<{ data: AssetUsageDto[] }> {
    return this.assets.usages(actor, params.assetId);
  }

  @Patch('assets/:assetId')
  @Endpoint({
    summary: "Update an asset's label or metadata (editor)",
    tags,
    params: assetIdParamsSchema,
    body: updateAssetRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: AssetParams,
    @ValidBody() body: UpdateAssetRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<AssetDto> {
    return this.assets.update(actor, params.assetId, body, expected);
  }

  @Post('assets/:assetId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive an asset (editor); refused while an approved version uses it',
    tags,
    params: assetIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: assetSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(@CurrentActor() actor: Actor, @ValidParams() params: AssetParams): Promise<AssetDto> {
    return this.assets.archive(actor, params.assetId);
  }
}
