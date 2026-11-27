import { HttpStatus, Injectable } from '@nestjs/common';

import { ApiErrorCode, type CollectionDto, type CollectionListDto } from '@acf/contracts';
import type { AssetCollection } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound, referenceNotFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';

const toDto = (c: AssetCollection & { _count: { items: number } }): CollectionDto => ({
  id: c.id,
  projectId: c.projectId,
  name: c.name,
  itemCount: c._count.items,
  archivedAt: c.archivedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

const WITH_COUNT = { _count: { select: { items: true } } } as const;

/**
 * Asset collections (P2b design L5): named groups of Library assets in one project. They only
 * organise the Library; no generation, selection or render reads them.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async list(
    actor: Actor,
    projectId: string,
    includeArchived: boolean,
  ): Promise<CollectionListDto> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.db.assetCollection.findMany({
      where: { projectId, ...(includeArchived ? {} : { archivedAt: null }) },
      include: WITH_COUNT,
      orderBy: { name: 'asc' },
    });
    return { data: rows.map(toDto) };
  }

  async create(actor: Actor, projectId: string, name: string): Promise<CollectionDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    await this.refuseDuplicate(projectId, name, null);
    const row = await this.db.assetCollection.create({
      data: { projectId, name, createdById: actor.userId },
      include: WITH_COUNT,
    });
    return toDto(row);
  }

  async rename(actor: Actor, collectionId: string, name: string): Promise<CollectionDto> {
    const c = await this.load(actor, collectionId);
    if (c.archivedAt) throw archived('collection');
    await this.refuseDuplicate(c.projectId, name, c.id);
    const row = await this.db.assetCollection.update({
      where: { id: c.id },
      data: { name },
      include: WITH_COUNT,
    });
    return toDto(row);
  }

  async archive(actor: Actor, collectionId: string): Promise<CollectionDto> {
    const c = await this.load(actor, collectionId);
    if (c.archivedAt) throw archived('collection');
    const row = await this.db.assetCollection.update({
      where: { id: c.id },
      data: { archivedAt: new Date() },
      include: WITH_COUNT,
    });
    return toDto(row);
  }

  /**
   * Brings an archived collection back (idempotent). Refused (`409 NAME_TAKEN`) when an active
   * collection took its name meanwhile: rename that one first.
   */
  async restore(actor: Actor, collectionId: string): Promise<CollectionDto> {
    const c = await this.load(actor, collectionId);
    if (c.archivedAt) await this.refuseDuplicate(c.projectId, c.name, c.id);
    const row = await this.db.assetCollection.update({
      where: { id: c.id },
      data: { archivedAt: null },
      include: WITH_COUNT,
    });
    return toDto(row);
  }

  /** Idempotent: adding an asset twice keeps one membership. */
  async add(actor: Actor, collectionId: string, assetId: string): Promise<CollectionDto> {
    const c = await this.load(actor, collectionId);
    if (c.archivedAt) throw archived('collection');
    const asset = await this.db.asset.findFirst({
      where: { id: assetId, projectId: c.projectId },
      select: { id: true },
    });
    if (!asset) throw referenceNotFound('asset');
    await this.db.assetCollectionItem.upsert({
      where: { collectionId_assetId: { collectionId: c.id, assetId } },
      create: { projectId: c.projectId, collectionId: c.id, assetId, addedById: actor.userId },
      update: {},
    });
    return this.get(c.id);
  }

  async remove(actor: Actor, collectionId: string, assetId: string): Promise<void> {
    const c = await this.load(actor, collectionId);
    await this.db.assetCollectionItem.deleteMany({ where: { collectionId: c.id, assetId } });
  }

  private async get(id: string): Promise<CollectionDto> {
    return toDto(
      await this.db.assetCollection.findUniqueOrThrow({ where: { id }, include: WITH_COUNT }),
    );
  }

  /** The collection, if the caller may edit its project (non-members: 404). */
  private async load(actor: Actor, collectionId: string): Promise<AssetCollection> {
    const c = await this.db.assetCollection.findUnique({ where: { id: collectionId } });
    if (!c) throw notFound('collection');
    await this.access.require(actor, c.projectId, 'editor', { mutation: true });
    return c;
  }

  private async refuseDuplicate(projectId: string, name: string, except: string | null) {
    const clash = await this.db.assetCollection.findFirst({
      where: {
        projectId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(except ? { NOT: { id: except } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ApiError({
        status: HttpStatus.CONFLICT,
        code: ApiErrorCode.NameTaken,
        message: 'An active collection of this project already has this name.',
      });
    }
  }
}
