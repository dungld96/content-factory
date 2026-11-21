import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  contentIdParamsSchema,
  contentItemSchema,
  createContentRequestSchema,
  listContentQuerySchema,
  pageSchema,
  projectIdParamsSchema,
  updateContentRequestSchema,
  type ContentItemDto,
  type CreateContentRequest,
  type Page,
  type UpdateContentRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { ContentService } from './content.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type ContentParams = z.infer<typeof contentIdParamsSchema>;

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Post('projects/:projectId/content')
  @Endpoint({
    summary:
      'Create a content item (and its content master) from a brief (editor); status starts as draft',
    tags: ['content'],
    params: projectIdParamsSchema,
    body: createContentRequestSchema,
    responses: { 201: { description: 'Created', schema: contentItemSchema } },
    errors: [400, 401, 403, 404, 409, 422],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: CreateContentRequest,
  ): Promise<ContentItemDto> {
    return this.content.create(actor, params.projectId, body);
  }

  @Get('projects/:projectId/content')
  @Endpoint({
    summary: 'List content items',
    tags: ['content'],
    params: projectIdParamsSchema,
    query: listContentQuerySchema,
    responses: {
      200: { description: 'Page of content items', schema: pageSchema(contentItemSchema) },
    },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.output<typeof listContentQuerySchema>,
  ): Promise<Page<ContentItemDto>> {
    return this.content.list(actor, params.projectId, query);
  }

  @Get('content/:contentId')
  @Endpoint({
    summary: 'Get a content item',
    tags: ['content'],
    params: contentIdParamsSchema,
    responses: { 200: { description: 'The content item', schema: contentItemSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: ContentParams): Promise<ContentItemDto> {
    return this.content.get(actor, params.contentId);
  }

  @Patch('content/:contentId')
  @Endpoint({
    summary: 'Update a content item (editor)',
    tags: ['content'],
    params: contentIdParamsSchema,
    body: updateContentRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: contentItemSchema } },
    errors: [400, 401, 403, 404, 409, 412, 422, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @ValidBody() body: UpdateContentRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<ContentItemDto> {
    return this.content.update(actor, params.contentId, body, expected);
  }

  @Post('content/:contentId/brief/resync')
  @HttpCode(200)
  @Endpoint({
    summary: "Copy the content master's current brief into this content item (editor)",
    tags: ['content'],
    params: contentIdParamsSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Resynced', schema: contentItemSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  resyncBrief(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
    @IfMatch() expected: Date | undefined,
  ): Promise<ContentItemDto> {
    return this.content.resyncBrief(actor, params.contentId, expected);
  }

  @Post('content/:contentId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive a content item (editor)',
    tags: ['content'],
    params: contentIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: contentItemSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ContentParams,
  ): Promise<ContentItemDto> {
    return this.content.archive(actor, params.contentId);
  }
}
