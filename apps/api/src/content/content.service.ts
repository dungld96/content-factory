import { Injectable } from '@nestjs/common';

import type {
  AspectRatio,
  ContentBrief,
  ContentItemDto,
  ContentStatus,
  CreateContentRequest,
  Page,
  UpdateContentRequest,
} from '@acf/contracts';
import type { AspectRatio as DbAspectRatio, ContentItem } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { definedOnly } from '../common/defined-only.js';
import {
  archived,
  guardedUpdateFailure,
  notFound,
  referenceNotFound,
} from '../common/domain-errors.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../common/http/pagination.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

const TO_DB_RATIO: Readonly<Record<AspectRatio, DbAspectRatio>> = {
  '9:16': 'ratio_9_16',
  '16:9': 'ratio_16_9',
  '1:1': 'ratio_1_1',
};
const FROM_DB_RATIO: Readonly<Record<DbAspectRatio, AspectRatio>> = {
  ratio_9_16: '9:16',
  ratio_16_9: '16:9',
  ratio_1_1: '1:1',
};

export function toContentItemDto(c: ContentItem): ContentItemDto {
  return {
    id: c.id,
    projectId: c.projectId,
    channelId: c.channelId,
    title: c.title,
    status: c.status,
    format: c.format,
    targetDurationSeconds: c.targetDurationSeconds,
    aspectRatio: FROM_DB_RATIO[c.aspectRatio],
    language: c.language,
    // Written only through the validated contract schema.
    brief: c.brief as ContentBrief,
    approvedScriptVersionId: c.approvedScriptVersionId,
    approvedStoryboardVersionId: c.approvedStoryboardVersionId,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
  ) {}

  /** `status` always starts as `draft`; transitions arrive in M3. */
  async create(
    actor: Actor,
    projectId: string,
    input: CreateContentRequest,
  ): Promise<ContentItemDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    if (input.channelId) await this.assertUsableChannel(projectId, input.channelId);
    const item = await this.prisma.client.contentItem.create({
      data: {
        projectId,
        channelId: input.channelId ?? null,
        title: input.title,
        format: input.format,
        targetDurationSeconds: input.targetDurationSeconds,
        aspectRatio: TO_DB_RATIO[input.aspectRatio],
        language: input.language,
        brief: input.brief,
        createdById: actor.userId,
      },
    });
    return toContentItemDto(item);
  }

  async list(
    actor: Actor,
    projectId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      includeArchived: boolean;
      channelId?: string | undefined;
      status?: ContentStatus | undefined;
    },
  ): Promise<Page<ContentItemDto>> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.prisma.client.contentItem.findMany({
      where: {
        projectId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.channelId ? { channelId: query.channelId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...keysetAfter(query.cursor),
      },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, toContentItemDto);
  }

  async get(actor: Actor, contentId: string): Promise<ContentItemDto> {
    const item = await this.load(contentId);
    await this.access.require(actor, item.projectId, 'viewer');
    return toContentItemDto(item);
  }

  async update(
    actor: Actor,
    contentId: string,
    input: UpdateContentRequest,
    expected: Date | undefined,
  ): Promise<ContentItemDto> {
    const item = await this.load(contentId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (input.channelId) await this.assertUsableChannel(item.projectId, input.channelId);
    const { aspectRatio, ...rest } = input;
    const { count } = await this.prisma.client.contentItem.updateMany({
      where: { id: contentId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: definedOnly({
        ...rest,
        aspectRatio: aspectRatio === undefined ? undefined : TO_DB_RATIO[aspectRatio],
      }),
    });
    const current = await this.prisma.client.contentItem.findUnique({ where: { id: contentId } });
    if (count === 0 || !current) throw guardedUpdateFailure(current, 'content item');
    return toContentItemDto(current);
  }

  async archive(actor: Actor, contentId: string): Promise<ContentItemDto> {
    const item = await this.load(contentId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    const { count } = await this.prisma.client.contentItem.updateMany({
      where: { id: contentId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (count === 0) throw archived('content item');
    return toContentItemDto(
      await this.prisma.client.contentItem.findUniqueOrThrow({ where: { id: contentId } }),
    );
  }

  /** The channel must belong to the project (also enforced by the composite FK) and be active. */
  private async assertUsableChannel(projectId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.client.channel.findFirst({
      where: { id: channelId, projectId },
      select: { archivedAt: true },
    });
    if (!channel) throw referenceNotFound('channel');
    if (channel.archivedAt) throw archived('channel');
  }

  private async load(contentId: string): Promise<ContentItem> {
    const item = await this.prisma.client.contentItem.findUnique({ where: { id: contentId } });
    if (!item) throw notFound('content item');
    return item;
  }
}
