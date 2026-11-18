import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  contentItemSchema,
  contentMasterDetailSchema,
  contentMasterIdParamsSchema,
  contentMasterSchema,
  createContentMasterRequestSchema,
  createVariantRequestSchema,
  listContentMastersQuerySchema,
  pageSchema,
  projectIdParamsSchema,
  updateContentMasterRequestSchema,
  type ContentItemDto,
  type ContentMasterDetailDto,
  type ContentMasterDto,
  type CreateContentMasterRequest,
  type CreateVariantRequest,
  type Page,
  type UpdateContentMasterRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { ContentMastersService } from './content-masters.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type MasterParams = z.infer<typeof contentMasterIdParamsSchema>;

/** Content masters and variants (R0, ADR-0015). Content items are the variants. */
@Controller()
export class ContentMastersController {
  constructor(private readonly masters: ContentMastersService) {}

  @Post('projects/:projectId/content-masters')
  @Endpoint({
    summary: 'Create a content master (shared brief) without variants (editor)',
    tags: ['content'],
    params: projectIdParamsSchema,
    body: createContentMasterRequestSchema,
    responses: { 201: { description: 'Created', schema: contentMasterSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: CreateContentMasterRequest,
  ): Promise<ContentMasterDto> {
    return this.masters.create(actor, params.projectId, body);
  }

  @Get('projects/:projectId/content-masters')
  @Endpoint({
    summary: 'List content masters',
    tags: ['content'],
    params: projectIdParamsSchema,
    query: listContentMastersQuerySchema,
    responses: {
      200: { description: 'Page of content masters', schema: pageSchema(contentMasterSchema) },
    },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.output<typeof listContentMastersQuerySchema>,
  ): Promise<Page<ContentMasterDto>> {
    return this.masters.list(actor, params.projectId, query);
  }

  @Get('content-masters/:masterId')
  @Endpoint({
    summary: 'Get a content master with its variants',
    tags: ['content'],
    params: contentMasterIdParamsSchema,
    responses: {
      200: { description: 'The master and its variants', schema: contentMasterDetailSchema },
    },
    errors: [400, 401, 404],
  })
  get(
    @CurrentActor() actor: Actor,
    @ValidParams() params: MasterParams,
  ): Promise<ContentMasterDetailDto> {
    return this.masters.get(actor, params.masterId);
  }

  @Patch('content-masters/:masterId')
  @Endpoint({
    summary: 'Update a content master; a brief change marks existing variants stale (editor)',
    tags: ['content'],
    params: contentMasterIdParamsSchema,
    body: updateContentMasterRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: contentMasterSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: MasterParams,
    @ValidBody() body: UpdateContentMasterRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<ContentMasterDto> {
    return this.masters.update(actor, params.masterId, body, expected);
  }

  @Post('content-masters/:masterId/variants')
  @Endpoint({
    summary: 'Create a variant (content item) that copies the master brief (editor)',
    tags: ['content'],
    params: contentMasterIdParamsSchema,
    body: createVariantRequestSchema,
    responses: { 201: { description: 'Created', schema: contentItemSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  createVariant(
    @CurrentActor() actor: Actor,
    @ValidParams() params: MasterParams,
    @ValidBody() body: CreateVariantRequest,
  ): Promise<ContentItemDto> {
    return this.masters.createVariant(actor, params.masterId, body);
  }

  @Post('content-masters/:masterId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive a content master once all its variants are archived (editor)',
    tags: ['content'],
    params: contentMasterIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: contentMasterSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(
    @CurrentActor() actor: Actor,
    @ValidParams() params: MasterParams,
  ): Promise<ContentMasterDto> {
    return this.masters.archive(actor, params.masterId);
  }
}
