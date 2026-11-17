import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';

import {
  channelIdParamsSchema,
  channelSchema,
  createChannelRequestSchema,
  listChannelsQuerySchema,
  pageSchema,
  projectIdParamsSchema,
  updateChannelRequestSchema,
  type ChannelDto,
  type CreateChannelRequest,
  type Page,
  type UpdateChannelRequest,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../common/http/endpoint.js';
import { IfMatch } from '../common/http/etag.js';
import { ChannelsService } from './channels.service.js';

type ProjectParams = z.infer<typeof projectIdParamsSchema>;
type ChannelParams = z.infer<typeof channelIdParamsSchema>;

@Controller()
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Post('projects/:projectId/channels')
  @Endpoint({
    summary: 'Create a channel (editor)',
    tags: ['channels'],
    params: projectIdParamsSchema,
    body: createChannelRequestSchema,
    responses: { 201: { description: 'Created', schema: channelSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  create(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidBody() body: CreateChannelRequest,
  ): Promise<ChannelDto> {
    return this.channels.create(actor, params.projectId, body);
  }

  @Get('projects/:projectId/channels')
  @Endpoint({
    summary: 'List channels',
    tags: ['channels'],
    params: projectIdParamsSchema,
    query: listChannelsQuerySchema,
    responses: { 200: { description: 'Page of channels', schema: pageSchema(channelSchema) } },
    errors: [400, 401, 404],
  })
  list(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ProjectParams,
    @ValidQuery() query: z.output<typeof listChannelsQuerySchema>,
  ): Promise<Page<ChannelDto>> {
    return this.channels.list(actor, params.projectId, query);
  }

  @Get('channels/:channelId')
  @Endpoint({
    summary: 'Get a channel',
    tags: ['channels'],
    params: channelIdParamsSchema,
    responses: { 200: { description: 'The channel', schema: channelSchema } },
    errors: [400, 401, 404],
  })
  get(@CurrentActor() actor: Actor, @ValidParams() params: ChannelParams): Promise<ChannelDto> {
    return this.channels.get(actor, params.channelId);
  }

  @Patch('channels/:channelId')
  @Endpoint({
    summary: 'Update a channel (editor)',
    tags: ['channels'],
    params: channelIdParamsSchema,
    body: updateChannelRequestSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Updated', schema: channelSchema } },
    errors: [400, 401, 403, 404, 409, 412, 428],
  })
  update(
    @CurrentActor() actor: Actor,
    @ValidParams() params: ChannelParams,
    @ValidBody() body: UpdateChannelRequest,
    @IfMatch() expected: Date | undefined,
  ): Promise<ChannelDto> {
    return this.channels.update(actor, params.channelId, body, expected);
  }

  @Post('channels/:channelId/archive')
  @HttpCode(200)
  @Endpoint({
    summary: 'Archive a channel (editor)',
    tags: ['channels'],
    params: channelIdParamsSchema,
    responses: { 200: { description: 'Archived', schema: channelSchema } },
    errors: [400, 401, 403, 404, 409],
  })
  archive(@CurrentActor() actor: Actor, @ValidParams() params: ChannelParams): Promise<ChannelDto> {
    return this.channels.archive(actor, params.channelId);
  }
}
