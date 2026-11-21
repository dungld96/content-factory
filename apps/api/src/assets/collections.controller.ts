import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import type { z } from 'zod';

import {
  collectionAssetParamsSchema,
  collectionIdParamsSchema,
  collectionListSchema,
  collectionNameRequestSchema,
  collectionSchema,
  listCollectionsQuerySchema,
  projectIdParamsSchema,
  type CollectionDto,
  type CollectionListDto,
  type CollectionNameRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { CollectionsService } from './collections.service.js';

const tags = ['assets'];

/** Asset collections (P2b design L5): organisational groups of Library assets. */
@Controller()
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get('projects/:projectId/collections')
  @Endpoint({
    summary: "A project's asset collections with item counts",
    tags,
    params: projectIdParamsSchema,
    query: listCollectionsQuerySchema,
    responses: { 200: { description: 'Collections', schema: collectionListSchema } },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof projectIdParamsSchema>,
    @ValidQuery() query: z.output<typeof listCollectionsQuerySchema>,
  ): Promise<CollectionListDto> {
    return this.collections.list(actor, params.projectId, query.includeArchived);
  }

  @Post('projects/:projectId/collections')
  @Endpoint({
    summary: 'Create an asset collection (editor)',
    tags,
    params: projectIdParamsSchema,
    body: collectionNameRequestSchema,
    responses: { 201: { description: 'The collection', schema: collectionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof projectIdParamsSchema>,
    @ValidBody() body: CollectionNameRequest,
  ): Promise<CollectionDto> {
    return this.collections.create(actor, params.projectId, body.name);
  }

  @Patch('collections/:collectionId')
  @Endpoint({
    summary: 'Rename an asset collection (editor)',
    tags,
    params: collectionIdParamsSchema,
    body: collectionNameRequestSchema,
    responses: { 200: { description: 'The collection', schema: collectionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  rename(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof collectionIdParamsSchema>,
    @ValidBody() body: CollectionNameRequest,
  ): Promise<CollectionDto> {
    return this.collections.rename(actor, params.collectionId, body.name);
  }

  @Post('collections/:collectionId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive an asset collection (editor)',
    tags,
    params: collectionIdParamsSchema,
    responses: { 200: { description: 'The collection', schema: collectionSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof collectionIdParamsSchema>,
  ): Promise<CollectionDto> {
    return this.collections.archive(actor, params.collectionId);
  }

  @Put('collections/:collectionId/assets/:assetId')
  @Endpoint({
    summary: 'Add an asset of the same project to a collection (editor; idempotent)',
    tags,
    params: collectionAssetParamsSchema,
    responses: { 200: { description: 'The collection', schema: collectionSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  add(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof collectionAssetParamsSchema>,
  ): Promise<CollectionDto> {
    return this.collections.add(actor, params.collectionId, params.assetId);
  }

  @Delete('collections/:collectionId/assets/:assetId')
  @HttpCode(204)
  @Endpoint({
    summary: 'Remove an asset from a collection (editor); the asset is unchanged',
    tags,
    params: collectionAssetParamsSchema,
    responses: { 204: { description: 'Removed' } },
    errors: [400, 401, 403, 404],
  })
  async remove(
    @CurrentActor() actor: Actor,
    @ValidParams() params: z.infer<typeof collectionAssetParamsSchema>,
  ): Promise<void> {
    await this.collections.remove(actor, params.collectionId, params.assetId);
  }
}
