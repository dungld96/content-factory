import { HttpStatus, Injectable } from '@nestjs/common';

import {
  ApiErrorCode,
  type ContentBrief,
  type ContentItemDto,
  type ContentMasterDetailDto,
  type ContentMasterDto,
  type CreateContentMasterRequest,
  type CreateVariantRequest,
  type Page,
  type UpdateContentMasterRequest,
} from '@acf/contracts';
import { INITIAL_BRIEF_REVISION, nextBriefRevision } from '@acf/content-domain';
import type { ContentMaster, Prisma } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { definedOnly } from '../common/defined-only.js';
import { archived, notFound } from '../common/domain-errors.js';
import { preconditionFailed } from '../common/http/etag.js';
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
} from './variants.js';

const ACTIVE_VARIANT_COUNT = {
  _count: { select: { variants: { where: { archivedAt: null } } } },
} as const satisfies Prisma.ContentMasterInclude;

type MasterRow = ContentMaster & { readonly _count: { readonly variants: number } };

function toContentMasterDto(m: MasterRow): ContentMasterDto {
  return {
    id: m.id,
    projectId: m.projectId,
    title: m.title,
    // Written only through the validated contract schema.
    brief: m.brief as ContentBrief,
    briefRevision: m.briefRevision,
    language: m.language,
    activeVariantCount: m._count.variants,
    archivedAt: m.archivedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/**
 * Content masters and their variants (R0; docs/design/M3.5-multiformat-architecture-review.md
 * §5.3, ADR-0015). Locking (READ COMMITTED, one row lock each, so no deadlock):
 * - create variant: master `FOR KEY SHARE` → refuse if archived → insert the variant;
 * - edit master: master `FOR NO KEY UPDATE` (does not block variant creation);
 * - archive master: master `FOR UPDATE` → refuse while a variant is active.
 * `FOR UPDATE` conflicts with `FOR KEY SHARE`, so an archive never misses a concurrent variant
 * (`packages/database/test/content-masters.integration.test.ts`).
 */
@Injectable()
export class ContentMastersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly tx: TransactionRunner,
  ) {}

  async create(
    actor: Actor,
    projectId: string,
    input: CreateContentMasterRequest,
  ): Promise<ContentMasterDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const master = await this.prisma.client.contentMaster.create({
      data: {
        projectId,
        title: input.title,
        brief: input.brief,
        briefRevision: INITIAL_BRIEF_REVISION,
        language: input.language,
        createdById: actor.userId,
      },
      include: ACTIVE_VARIANT_COUNT,
    });
    return toContentMasterDto(master);
  }

  async list(
    actor: Actor,
    projectId: string,
    query: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<ContentMasterDto>> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.prisma.client.contentMaster.findMany({
      where: {
        projectId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...keysetAfter(query.cursor),
      },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
      include: ACTIVE_VARIANT_COUNT,
    });
    return toPage(rows, query.limit, toContentMasterDto);
  }

  async get(actor: Actor, masterId: string): Promise<ContentMasterDetailDto> {
    const master = await this.load(masterId);
    await this.access.require(actor, master.projectId, 'viewer');
    const variants = await this.prisma.client.contentItem.findMany({
      where: { contentMasterId: masterId },
      orderBy: NEWEST_FIRST,
      include: CONTENT_ITEM_LINKS,
    });
    return { ...toContentMasterDto(master), variants: variants.map(toContentItemDto) };
  }

  async update(
    actor: Actor,
    masterId: string,
    input: UpdateContentMasterRequest,
    expected: Date | undefined,
  ): Promise<ContentMasterDto> {
    const master = await this.load(masterId);
    await this.access.require(actor, master.projectId, 'editor', { mutation: true });
    const updated = await this.tx.run('content-master.update', async (tx) => {
      const rows = await tx.$queryRaw<
        { archived_at: Date | null; updated_at: Date; brief: unknown; brief_revision: number }[]
      >`SELECT archived_at, updated_at, brief, brief_revision FROM content_masters
          WHERE id = ${masterId}::uuid FOR NO KEY UPDATE`;
      const row = rows[0];
      if (!row) throw notFound('content master');
      if (row.archived_at) throw archived('content master');
      if (expected && row.updated_at.getTime() !== expected.getTime()) throw preconditionFailed();
      return tx.contentMaster.update({
        where: { id: masterId },
        data: definedOnly({
          title: input.title,
          language: input.language,
          brief: input.brief,
          briefRevision:
            input.brief === undefined
              ? undefined
              : nextBriefRevision(row.brief_revision, row.brief, input.brief),
        }),
        include: ACTIVE_VARIANT_COUNT,
      });
    });
    return toContentMasterDto(updated);
  }

  /** A new variant copies the master's brief and records its revision. */
  async createVariant(
    actor: Actor,
    masterId: string,
    input: CreateVariantRequest,
  ): Promise<ContentItemDto> {
    const master = await this.load(masterId);
    const projectId = master.projectId;
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const item = await this.tx.run('content-master.create-variant', async (tx) => {
      const rows = await tx.$queryRaw<
        {
          archived_at: Date | null;
          title: string;
          language: string;
          brief: Prisma.InputJsonValue;
          brief_revision: number;
        }[]
      >`SELECT archived_at, title, language, brief, brief_revision FROM content_masters
          WHERE id = ${masterId}::uuid FOR KEY SHARE`;
      const row = rows[0];
      if (!row) throw notFound('content master');
      if (row.archived_at) throw archived('content master');
      const channelPlatform = input.channelId
        ? await usableChannelPlatform(tx, projectId, input.channelId)
        : null;
      const targetPlatform = storedTargetPlatform({
        format: input.format,
        channelPlatform,
        targetPlatform: input.targetPlatform,
      });
      return tx.contentItem.create({
        data: {
          projectId,
          contentMasterId: masterId,
          masterBriefRevision: row.brief_revision,
          channelId: input.channelId ?? null,
          targetPlatform,
          title: input.title ?? row.title,
          format: input.format,
          targetDurationSeconds: input.targetDurationSeconds,
          aspectRatio: TO_DB_RATIO[input.aspectRatio],
          language: input.language ?? row.language,
          brief: row.brief,
          createdById: actor.userId,
        },
        include: CONTENT_ITEM_LINKS,
      });
    });
    return toContentItemDto(item);
  }

  /** Archives the master once every variant is archived (`409 MASTER_HAS_ACTIVE_VARIANTS`). */
  async archive(actor: Actor, masterId: string): Promise<ContentMasterDto> {
    const master = await this.load(masterId);
    await this.access.require(actor, master.projectId, 'editor', { mutation: true });
    const result = await this.tx.run('content-master.archive', async (tx) => {
      const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
        SELECT archived_at FROM content_masters WHERE id = ${masterId}::uuid FOR UPDATE`;
      if (rows[0]?.archived_at) throw archived('content master');
      const active = await tx.contentItem.count({
        where: { contentMasterId: masterId, archivedAt: null },
      });
      if (active > 0) {
        throw new ApiError({
          status: HttpStatus.CONFLICT,
          code: ApiErrorCode.MasterHasActiveVariants,
          message: `Archive the master's ${String(active)} active variant(s) first.`,
        });
      }
      return tx.contentMaster.update({
        where: { id: masterId },
        data: { archivedAt: new Date() },
        include: ACTIVE_VARIANT_COUNT,
      });
    });
    return toContentMasterDto(result);
  }

  private async load(masterId: string): Promise<MasterRow> {
    const master = await this.prisma.client.contentMaster.findUnique({
      where: { id: masterId },
      include: ACTIVE_VARIANT_COUNT,
    });
    if (!master) throw notFound('content master');
    return master;
  }
}
