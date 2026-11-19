import { Injectable } from '@nestjs/common';

import type {
  ContentItemDto,
  ContentStatus,
  CreateContentRequest,
  Page,
  UpdateContentRequest,
} from '@acf/contracts';
import { INITIAL_BRIEF_REVISION } from '@acf/content-domain';

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
import { TransactionRunner } from '../infrastructure/transaction-runner.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import {
  CONTENT_ITEM_LINKS,
  storedTargetPlatform,
  TO_DB_RATIO,
  toContentItemDto,
  usableChannelPlatform,
  type ContentItemRow,
} from './variants.js';

export { toContentItemDto } from './variants.js';

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly tx: TransactionRunner,
  ) {}

  /**
   * `status` always starts as `draft`. R0: creates the content master and this item as its
   * first variant in one transaction (ADR-0015); the request body is unchanged.
   */
  async create(
    actor: Actor,
    projectId: string,
    input: CreateContentRequest,
  ): Promise<ContentItemDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const item = await this.tx.run('content.create', async (tx) => {
      const channelPlatform = input.channelId
        ? await usableChannelPlatform(tx, projectId, input.channelId)
        : null;
      const targetPlatform = storedTargetPlatform({
        format: input.format,
        channelPlatform,
        targetPlatform: input.targetPlatform,
      });
      const master = await tx.contentMaster.create({
        data: {
          projectId,
          title: input.title,
          brief: input.brief,
          briefRevision: INITIAL_BRIEF_REVISION,
          language: input.language,
          createdById: actor.userId,
        },
      });
      return tx.contentItem.create({
        data: {
          projectId,
          contentMasterId: master.id,
          masterBriefRevision: master.briefRevision,
          channelId: input.channelId ?? null,
          targetPlatform,
          title: input.title,
          format: input.format,
          targetDurationSeconds: input.targetDurationSeconds,
          aspectRatio: TO_DB_RATIO[input.aspectRatio],
          language: input.language,
          brief: input.brief,
          createdById: actor.userId,
        },
        include: CONTENT_ITEM_LINKS,
      });
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
      include: CONTENT_ITEM_LINKS,
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
    const channelPlatform = input.channelId
      ? await usableChannelPlatform(this.prisma.client, item.projectId, input.channelId)
      : null;
    if (input.voiceProfileId) {
      const profile = await this.prisma.client.voiceProfile.findFirst({
        where: { id: input.voiceProfileId, projectId: item.projectId, archivedAt: null },
        select: { id: true },
      });
      if (!profile) throw referenceNotFound('voice profile');
    }
    const { aspectRatio, targetPlatform, ...rest } = input;
    const platformTouched = input.channelId !== undefined || targetPlatform !== undefined;
    const storedPlatform = platformTouched
      ? storedTargetPlatform({
          format: item.format,
          // The channel after this update: the new one, none, or the unchanged current one.
          channelPlatform:
            input.channelId === undefined ? (item.channel?.platform ?? null) : channelPlatform,
          targetPlatform:
            targetPlatform !== undefined
              ? targetPlatform
              : input.channelId === undefined
                ? item.targetPlatform
                : null,
        })
      : undefined;
    const { count } = await this.prisma.client.contentItem.updateMany({
      where: { id: contentId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: definedOnly({
        ...rest,
        aspectRatio: aspectRatio === undefined ? undefined : TO_DB_RATIO[aspectRatio],
        targetPlatform: storedPlatform,
      }),
    });
    const current = await this.prisma.client.contentItem.findUnique({
      where: { id: contentId },
      include: CONTENT_ITEM_LINKS,
    });
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
      await this.prisma.client.contentItem.findUniqueOrThrow({
        where: { id: contentId },
        include: CONTENT_ITEM_LINKS,
      }),
    );
  }

  /**
   * Copies the master's current brief into this variant (R0): an ordinary brief edit, after
   * which `masterBriefStale` is false. Existing scripts keep their versions; new generations
   * use the new brief.
   */
  async resyncBrief(
    actor: Actor,
    contentId: string,
    expected: Date | undefined,
  ): Promise<ContentItemDto> {
    const item = await this.load(contentId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    const master = await this.prisma.client.contentMaster.findUniqueOrThrow({
      where: { id: item.contentMasterId },
      select: { brief: true, briefRevision: true },
    });
    const { count } = await this.prisma.client.contentItem.updateMany({
      where: { id: contentId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: { brief: master.brief ?? {}, masterBriefRevision: master.briefRevision },
    });
    const current = await this.prisma.client.contentItem.findUnique({
      where: { id: contentId },
      include: CONTENT_ITEM_LINKS,
    });
    if (count === 0 || !current) throw guardedUpdateFailure(current, 'content item');
    return toContentItemDto(current);
  }

  private async load(contentId: string): Promise<ContentItemRow> {
    const item = await this.prisma.client.contentItem.findUnique({
      where: { id: contentId },
      include: CONTENT_ITEM_LINKS,
    });
    if (!item) throw notFound('content item');
    return item;
  }
}
