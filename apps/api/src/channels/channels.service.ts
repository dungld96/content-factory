import { Injectable } from '@nestjs/common';

import type { ChannelDto, CreateChannelRequest, Page, UpdateChannelRequest } from '@acf/contracts';
import type { Channel } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { definedOnly } from '../common/defined-only.js';
import { archived, guardedUpdateFailure, notFound } from '../common/domain-errors.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../common/http/pagination.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

export function toChannelDto(c: Channel): ChannelDto {
  return {
    id: c.id,
    projectId: c.projectId,
    name: c.name,
    slug: c.slug,
    platform: c.platform,
    handle: c.handle,
    description: c.description,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
  ) {}

  async create(actor: Actor, projectId: string, input: CreateChannelRequest): Promise<ChannelDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const channel = await this.prisma.client.channel.create({
      data: {
        projectId,
        name: input.name,
        slug: input.slug,
        platform: input.platform,
        handle: input.handle ?? null,
        description: input.description ?? null,
        createdById: actor.userId,
      },
    });
    return toChannelDto(channel);
  }

  async list(
    actor: Actor,
    projectId: string,
    query: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<ChannelDto>> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.prisma.client.channel.findMany({
      where: {
        projectId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...keysetAfter(query.cursor),
      },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, toChannelDto);
  }

  async get(actor: Actor, channelId: string): Promise<ChannelDto> {
    const channel = await this.load(channelId);
    await this.access.require(actor, channel.projectId, 'viewer');
    return toChannelDto(channel);
  }

  async update(
    actor: Actor,
    channelId: string,
    input: UpdateChannelRequest,
    expected: Date | undefined,
  ): Promise<ChannelDto> {
    const channel = await this.load(channelId);
    await this.access.require(actor, channel.projectId, 'editor', { mutation: true });
    const { count } = await this.prisma.client.channel.updateMany({
      where: { id: channelId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: definedOnly(input),
    });
    const current = await this.prisma.client.channel.findUnique({ where: { id: channelId } });
    if (count === 0 || !current) throw guardedUpdateFailure(current, 'channel');
    return toChannelDto(current);
  }

  async archive(actor: Actor, channelId: string): Promise<ChannelDto> {
    const channel = await this.load(channelId);
    await this.access.require(actor, channel.projectId, 'editor', { mutation: true });
    const { count } = await this.prisma.client.channel.updateMany({
      where: { id: channelId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (count === 0) throw archived('channel');
    return toChannelDto(
      await this.prisma.client.channel.findUniqueOrThrow({ where: { id: channelId } }),
    );
  }

  /** Brings an archived channel back (editor, idempotent). */
  async restore(actor: Actor, channelId: string): Promise<ChannelDto> {
    const channel = await this.load(channelId);
    await this.access.require(actor, channel.projectId, 'editor', { mutation: true });
    await this.prisma.client.channel.updateMany({
      where: { id: channelId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    return toChannelDto(
      await this.prisma.client.channel.findUniqueOrThrow({ where: { id: channelId } }),
    );
  }

  /** Loads the row to derive its project; callers must then check access (404 either way). */
  private async load(channelId: string): Promise<Channel> {
    const channel = await this.prisma.client.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw notFound('channel');
    return channel;
  }
}
