import { HttpStatus } from '@nestjs/common';

import {
  ApiErrorCode,
  type CreateVersionedEntityRequest,
  type CreateVersionRequest,
  type Page,
  type UpdateVersionedEntityRequest,
  type UpdateVersionRequest,
  type VersionAssetLink,
  type VersionDto,
  type VersionedEntityDto,
} from '@acf/contracts';
import { Prisma, uuidv7, type TransactionClient } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import {
  archived,
  guardedUpdateFailure,
  notFound,
  referenceNotFound,
} from '../common/domain-errors.js';
import { preconditionFailed } from '../common/http/etag.js';
import { decodeCursor, encodeCursor } from '../common/http/pagination.js';
import type { PrismaService } from '../infrastructure/prisma.service.js';
import type { TransactionRunner } from '../infrastructure/transaction-runner.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import type { VersionedKind } from './versioned-kind.js';

const { sql, join, empty } = Prisma;

interface ParentRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  description: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  master_id: string | null;
  master_version: number | null;
  master_approved_at: Date | null;
}

interface VersionRow {
  id: string;
  project_id: string;
  parent_id: string;
  version: number;
  status: 'draft' | 'approved';
  description: string;
  rules: Record<string, unknown>;
  primary_asset_id: string | null;
  based_on_version_id: string | null;
  created_by_id: string;
  approved_by_id: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface LinkRow {
  asset_id: string;
  sort_order: number;
  note: string | null;
}

type Db = PrismaService['client'] | TransactionClient;

const conflict = (code: string, message: string, current?: unknown) =>
  new ApiError({ status: HttpStatus.CONFLICT, code, message, current });

function toEntityDto(row: ParentRow): VersionedEntityDto {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    master:
      row.master_id && row.master_version !== null && row.master_approved_at
        ? {
            id: row.master_id,
            version: row.master_version,
            approvedAt: row.master_approved_at.toISOString(),
          }
        : null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersionDto(row: VersionRow, links: readonly LinkRow[]): VersionDto {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    version: row.version,
    status: row.status,
    description: row.description,
    rules: row.rules,
    primaryAssetId: row.primary_asset_id,
    basedOnVersionId: row.based_on_version_id,
    createdById: row.created_by_id,
    approvedById: row.approved_by_id,
    approvedAt: row.approved_at?.toISOString() ?? null,
    assets: links.map((l) => ({ assetId: l.asset_id, sortOrder: l.sort_order, note: l.note })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `(created_at, id) < cursor` for `ORDER BY created_at DESC, id DESC`. */
function keysetBefore(alias: Prisma.Sql, cursor: string | undefined): Prisma.Sql {
  if (cursor === undefined) return empty;
  const { createdAt, id } = decodeCursor(cursor);
  return sql`AND (${alias}.created_at, ${alias}.id) < (${createdAt}::timestamptz, ${id}::uuid)`;
}

/**
 * Characters and environments: reusable brand entities with append-only, immutable approved
 * versions and a master pointer (ADR-0010; design package §7). One instance per kind.
 *
 * Every transaction takes row locks in the global protocol order (ADR-0011 §5):
 * link row → version → parent → asset rows (ascending id). The database triggers enforce the
 * same invariants for any client; the checks here return precise 4xx errors first.
 */
export class VersionedEntityService {
  constructor(
    readonly kind: VersionedKind,
    private readonly prisma: PrismaService,
    private readonly runner: TransactionRunner,
    private readonly access: ProjectAccess,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  // ------------------------------------------------------------------ parents

  private parentSelect(where: Prisma.Sql): Prisma.Sql {
    const { parentTable: P, versionTable: V } = this.kind;
    return sql`
      SELECT p.id, p.project_id, p.name, p.slug, p.description, p.archived_at, p.created_at,
             p.updated_at, mv.id AS master_id, mv.version AS master_version,
             mv.approved_at AS master_approved_at
        FROM ${P} p LEFT JOIN ${V} mv ON mv.id = p.master_version_id
       WHERE ${where}`;
  }

  private async loadParent(id: string, db: Db = this.db): Promise<ParentRow> {
    const [row] = await db.$queryRaw<ParentRow[]>(this.parentSelect(sql`p.id = ${id}::uuid`));
    if (!row) throw notFound(this.kind.label);
    return row;
  }

  async create(
    actor: Actor,
    projectId: string,
    input: CreateVersionedEntityRequest,
  ): Promise<VersionedEntityDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const id = uuidv7();
    await this.db.$executeRaw`
      INSERT INTO ${this.kind.parentTable}
        (id, project_id, name, slug, description, created_by_id, updated_at)
      VALUES (${id}::uuid, ${projectId}::uuid, ${input.name}, ${input.slug},
              ${input.description ?? null}, ${actor.userId}::uuid, now())`;
    return toEntityDto(await this.loadParent(id));
  }

  async list(
    actor: Actor,
    projectId: string,
    query: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<VersionedEntityDto>> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.db.$queryRaw<ParentRow[]>(
      sql`${this.parentSelect(sql`p.project_id = ${projectId}::uuid`)}
        ${query.includeArchived ? empty : sql`AND p.archived_at IS NULL`}
        ${keysetBefore(sql`p`, query.cursor)}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${query.limit + 1}`,
    );
    return this.page(rows, query.limit, toEntityDto);
  }

  async get(actor: Actor, id: string): Promise<VersionedEntityDto> {
    const row = await this.loadParent(id);
    await this.access.require(actor, row.project_id, 'viewer');
    return toEntityDto(row);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateVersionedEntityRequest,
    expected: Date | undefined,
  ): Promise<VersionedEntityDto> {
    const row = await this.loadParent(id);
    await this.access.require(actor, row.project_id, 'editor', { mutation: true });
    const sets: Prisma.Sql[] = [sql`updated_at = now()`];
    if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
    if (input.slug !== undefined) sets.push(sql`slug = ${input.slug}`);
    if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
    const count = await this.db.$executeRaw`
      UPDATE ${this.kind.parentTable} SET ${join(sets, ', ')}
       WHERE id = ${id}::uuid AND archived_at IS NULL
         ${expected ? sql`AND updated_at = ${expected}::timestamptz` : empty}`;
    const current = await this.loadParent(id).catch(() => null);
    if (count === 0 || !current) {
      throw guardedUpdateFailure(current && { archivedAt: current.archived_at }, this.kind.label);
    }
    return toEntityDto(current);
  }

  async archive(actor: Actor, id: string): Promise<VersionedEntityDto> {
    const row = await this.loadParent(id);
    await this.access.require(actor, row.project_id, 'editor', { mutation: true });
    const count = await this.db.$executeRaw`
      UPDATE ${this.kind.parentTable} SET archived_at = now(), updated_at = now()
       WHERE id = ${id}::uuid AND archived_at IS NULL`;
    if (count === 0) throw archived(this.kind.label);
    return toEntityDto(await this.loadParent(id));
  }

  /** Brings an archived character/environment back (editor, idempotent). */
  async restore(actor: Actor, id: string): Promise<VersionedEntityDto> {
    const row = await this.loadParent(id);
    await this.access.require(actor, row.project_id, 'editor', { mutation: true });
    await this.db.$executeRaw`
      UPDATE ${this.kind.parentTable} SET archived_at = NULL, updated_at = now()
       WHERE id = ${id}::uuid AND archived_at IS NOT NULL`;
    return toEntityDto(await this.loadParent(id));
  }

  // ------------------------------------------------------------------ versions

  private versionSelect(where: Prisma.Sql): Prisma.Sql {
    const { versionTable: V, parentFk, rulesColumn } = this.kind;
    return sql`
      SELECT v.id, v.project_id, v.${parentFk} AS parent_id, v.version, v.status::text AS status,
             v.description, v.${rulesColumn} AS rules, v.primary_asset_id, v.based_on_version_id,
             v.created_by_id, v.approved_by_id, v.approved_at, v.created_at, v.updated_at
        FROM ${V} v WHERE ${where}`;
  }

  private async loadVersion(id: string, db: Db = this.db, lock = false): Promise<VersionRow> {
    const [row] = await db.$queryRaw<VersionRow[]>(
      sql`${this.versionSelect(sql`v.id = ${id}::uuid`)} ${lock ? sql`FOR UPDATE` : empty}`,
    );
    if (!row) throw notFound('version');
    return row;
  }

  private loadLinks(versionId: string, db: Db = this.db): Promise<LinkRow[]> {
    return db.$queryRaw<LinkRow[]>`
      SELECT asset_id, sort_order, note FROM ${this.kind.linkTable}
       WHERE ${this.kind.linkFk} = ${versionId}::uuid ORDER BY sort_order, asset_id`;
  }

  private async versionDto(id: string, db: Db = this.db): Promise<VersionDto> {
    return toVersionDto(await this.loadVersion(id, db), await this.loadLinks(id, db));
  }

  /**
   * New references must be active assets of the same project. (Drafts may keep an asset that
   * is archived later; approval then refuses them: decision U4.)
   */
  private async assertAssetsUsable(
    db: Db,
    projectId: string,
    assetIds: readonly string[],
  ): Promise<void> {
    if (assetIds.length === 0) return;
    const rows = await db.$queryRaw<{ id: string; archived_at: Date | null }[]>`
      SELECT id, archived_at FROM assets
       WHERE project_id = ${projectId}::uuid AND id = ANY (${[...assetIds]}::uuid[])`;
    if (rows.length !== new Set(assetIds).size) throw referenceNotFound('asset');
    if (rows.some((r) => r.archived_at !== null)) {
      throw conflict(ApiErrorCode.AssetArchived, 'An asset is archived and cannot be referenced.');
    }
  }

  private async insertLinks(
    tx: TransactionClient,
    projectId: string,
    versionId: string,
    links: readonly VersionAssetLink[],
  ): Promise<void> {
    if (links.length === 0) return;
    const values = links.map(
      (l) =>
        sql`(${projectId}::uuid, ${versionId}::uuid, ${l.assetId}::uuid, ${l.sortOrder}, ${l.note ?? null})`,
    );
    await tx.$executeRaw`
      INSERT INTO ${this.kind.linkTable} (project_id, ${this.kind.linkFk}, asset_id, sort_order, note)
      VALUES ${join(values, ', ')}`;
  }

  /** New draft, optionally copied from an older version (append-only rollback, ADR-0010 §5). */
  async createVersion(
    actor: Actor,
    parentId: string,
    input: CreateVersionRequest,
  ): Promise<VersionDto> {
    const parent = await this.loadParent(parentId);
    await this.access.require(actor, parent.project_id, 'editor', { mutation: true });
    const projectId = parent.project_id;
    const id = uuidv7();
    await this.runner.run(`${this.kind.key}.create_version`, async (tx) => {
      // Lock the parent: serializes with approvals and other version creations (design §7).
      const [locked] = await tx.$queryRaw<{ archived_at: Date | null }[]>`
        SELECT archived_at FROM ${this.kind.parentTable} WHERE id = ${parentId}::uuid FOR NO KEY UPDATE`;
      if (!locked) throw notFound(this.kind.label);
      if (locked.archived_at) throw archived(this.kind.label);

      let base: { row: VersionRow; links: LinkRow[] } | undefined;
      if (input.basedOnVersionId) {
        const [row] = await tx.$queryRaw<VersionRow[]>(
          this.versionSelect(
            sql`v.id = ${input.basedOnVersionId}::uuid AND v.${this.kind.parentFk} = ${parentId}::uuid`,
          ),
        );
        if (!row) throw referenceNotFound(`${this.kind.label} version`);
        base = { row, links: await this.loadLinks(row.id, tx) };
      }
      const description = input.description ?? base?.row.description ?? '';
      const rules = input.rules ?? base?.row.rules ?? {};
      const primaryAssetId =
        input.primaryAssetId !== undefined
          ? input.primaryAssetId
          : (base?.row.primary_asset_id ?? null);
      const links: VersionAssetLink[] =
        input.assets ??
        base?.links.map((l) => ({
          assetId: l.asset_id,
          sortOrder: l.sort_order,
          ...(l.note === null ? {} : { note: l.note }),
        })) ??
        [];
      await this.assertAssetsUsable(tx, projectId, [
        ...(primaryAssetId ? [primaryAssetId] : []),
        ...links.map((l) => l.assetId),
      ]);

      const [next] = await tx.$queryRaw<{ n: number }[]>`
        SELECT coalesce(max(version), 0)::int + 1 AS n FROM ${this.kind.versionTable}
         WHERE ${this.kind.parentFk} = ${parentId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO ${this.kind.versionTable}
          (id, project_id, ${this.kind.parentFk}, version, status, description, ${this.kind.rulesColumn},
           primary_asset_id, based_on_version_id, created_by_id, updated_at)
        VALUES (${id}::uuid, ${projectId}::uuid, ${parentId}::uuid, ${next?.n ?? 1}, 'draft', ${description},
                ${JSON.stringify(rules)}::jsonb, ${primaryAssetId}::uuid, ${input.basedOnVersionId ?? null}::uuid,
                ${actor.userId}::uuid, now())`;
      await this.insertLinks(tx, projectId, id, links);
    });
    return this.versionDto(id);
  }

  async listVersions(
    actor: Actor,
    parentId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<Page<VersionDto>> {
    const parent = await this.loadParent(parentId);
    await this.access.require(actor, parent.project_id, 'viewer');
    // Versions are created under the parent lock, so creation order equals version order.
    const rows = await this.db.$queryRaw<VersionRow[]>(
      sql`${this.versionSelect(sql`v.${this.kind.parentFk} = ${parentId}::uuid`)}
        ${keysetBefore(sql`v`, query.cursor)}
        ORDER BY v.created_at DESC, v.id DESC LIMIT ${query.limit + 1}`,
    );
    const page = this.page(rows, query.limit, (r) => r);
    const data = await Promise.all(
      page.data.map(async (r) => toVersionDto(r, await this.loadLinks(r.id))),
    );
    return { data, page: page.page };
  }

  async getVersion(actor: Actor, versionId: string): Promise<VersionDto> {
    const row = await this.loadVersion(versionId);
    await this.access.require(actor, row.project_id, 'viewer');
    return toVersionDto(row, await this.loadLinks(versionId));
  }

  /** Drafts only (decision D11); approved versions are immutable. */
  async updateVersion(
    actor: Actor,
    versionId: string,
    input: UpdateVersionRequest,
    expected: Date | undefined,
  ): Promise<VersionDto> {
    const row = await this.loadVersion(versionId);
    await this.access.require(actor, row.project_id, 'editor', { mutation: true });
    await this.assertParentActive(row.parent_id);
    if (row.status === 'approved') throw this.versionImmutable();
    if (input.primaryAssetId)
      await this.assertAssetsUsable(this.db, row.project_id, [input.primaryAssetId]);

    const sets: Prisma.Sql[] = [sql`updated_at = now()`];
    if (input.description !== undefined) sets.push(sql`description = ${input.description}`);
    if (input.rules !== undefined)
      sets.push(sql`${this.kind.rulesColumn} = ${JSON.stringify(input.rules)}::jsonb`);
    if (input.primaryAssetId !== undefined)
      sets.push(sql`primary_asset_id = ${input.primaryAssetId}::uuid`);
    const count = await this.db.$executeRaw`
      UPDATE ${this.kind.versionTable} SET ${join(sets, ', ')}
       WHERE id = ${versionId}::uuid AND status = 'draft'
         ${expected ? sql`AND updated_at = ${expected}::timestamptz` : empty}`;
    if (count === 0) await this.explainVersionUpdate(versionId);
    return this.versionDto(versionId);
  }

  /**
   * Replaces a draft's asset links, and changes the version's ETag so a reviewer's `If-Match`
   * on approve covers the links.
   *
   * Locks the version row FIRST (ADR-0011 §5, documented exception to "link row → version"):
   * - Without it, two concurrent replacements both took the link trigger's `FOR SHARE` on the
   *   version and then both upgraded for the final UPDATE: a lock-upgrade deadlock (40P01).
   * - Worse, each DELETE ran on a snapshot that could not see the other's uncommitted inserts,
   *   so the two link sets were merged instead of replaced.
   * With the version locked, replacements serialize; the waiter's DELETE is a new statement
   * with a fresh snapshot, so it removes the links committed by the first. The only remaining
   * cycle is with raw multi-row link edits outside the protocol (accepted by ADR-0011 §6).
   */
  async replaceAssets(
    actor: Actor,
    versionId: string,
    links: readonly VersionAssetLink[],
    expected: Date | undefined,
  ): Promise<VersionDto> {
    const row = await this.loadVersion(versionId);
    await this.access.require(actor, row.project_id, 'editor', { mutation: true });
    await this.assertParentActive(row.parent_id);
    if (row.status === 'approved') throw this.versionImmutable();
    await this.assertAssetsUsable(
      this.db,
      row.project_id,
      links.map((l) => l.assetId),
    );

    await this.runner.run(`${this.kind.key}.replace_assets`, async (tx) => {
      // 1. Lock the version (conflicts with approval's FOR UPDATE and other replacements).
      const [locked] = await tx.$queryRaw<{ status: string; updated_at: Date }[]>`
        SELECT status::text AS status, updated_at FROM ${this.kind.versionTable}
         WHERE id = ${versionId}::uuid FOR NO KEY UPDATE`;
      if (!locked) throw notFound('version');
      if (locked.status === 'approved') throw this.versionImmutable();
      if (expected && locked.updated_at.getTime() !== expected.getTime()) {
        throw preconditionFailed();
      }
      // 2. Replace the links (fresh snapshot: sees every committed link of this version).
      await tx.$executeRaw`
        DELETE FROM ${this.kind.linkTable} WHERE ${this.kind.linkFk} = ${versionId}::uuid`;
      await this.insertLinks(tx, row.project_id, versionId, links);
      // 3. Bump the ETag (row already locked by this transaction).
      await tx.$executeRaw`
        UPDATE ${this.kind.versionTable} SET updated_at = now() WHERE id = ${versionId}::uuid`;
    });
    return this.versionDto(versionId);
  }

  /**
   * Approves a draft and moves the master pointer atomically (ADR-0010 §3; design §7):
   * version FOR UPDATE → parent FOR NO KEY UPDATE → assets FOR NO KEY UPDATE (ascending id),
   * then validate, approve, move the pointer. The deferred trigger re-checks at COMMIT.
   */
  async approve(actor: Actor, versionId: string, expected: Date | undefined): Promise<VersionDto> {
    const pre = await this.loadVersion(versionId);
    await this.access.require(actor, pre.project_id, 'editor', { mutation: true });
    const { versionTable: V, parentTable: P, linkTable: L, linkFk } = this.kind;

    await this.runner.run(`${this.kind.key}.approve`, async (tx) => {
      const version = await this.loadVersion(versionId, tx, true); // 1. version
      // 2. Lock the parent alone. Do not join the master into this statement: after waiting
      // for the lock, READ COMMITTED re-checks only the locked row, so a joined master row
      // would be stale and a concurrent approval of a newer version would go unnoticed.
      const [parent] = await tx.$queryRaw<
        { archived_at: Date | null; master_version_id: string | null }[]
      >`
        SELECT archived_at, master_version_id FROM ${P}
         WHERE id = ${version.parent_id}::uuid FOR NO KEY UPDATE`;
      // A new statement takes a fresh snapshot, so it sees a master committed while we waited.
      const [master] = parent?.master_version_id
        ? await tx.$queryRaw<{ version: number }[]>`
            SELECT version FROM ${V} WHERE id = ${parent.master_version_id}::uuid`
        : [];
      const assets = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
        SELECT id, archived_at FROM assets
         WHERE id IN (SELECT primary_asset_id FROM ${V} WHERE id = ${versionId}::uuid
                      UNION SELECT asset_id FROM ${L} WHERE ${linkFk} = ${versionId}::uuid)
         ORDER BY id FOR NO KEY UPDATE`; // 3. assets, ascending id

      if (version.status === 'approved') {
        throw conflict(
          ApiErrorCode.AlreadyApproved,
          'This version is already approved.',
          toVersionDto(version, await this.loadLinks(versionId, tx)),
        );
      }
      if (expected && version.updated_at.getTime() !== expected.getTime())
        throw preconditionFailed();
      if (!parent) throw notFound(this.kind.label);
      if (parent.archived_at) throw archived(this.kind.label);
      if (master && version.version <= master.version) {
        throw conflict(
          ApiErrorCode.StaleDraft,
          `Version ${version.version} is older than the master (v${master.version}). ` +
            'Create a new draft based on it instead.',
        );
      }
      if (assets.some((a) => a.archived_at !== null)) {
        throw conflict(ApiErrorCode.AssetArchived, 'The version references an archived asset.');
      }

      await tx.$executeRaw`
        UPDATE ${V} SET status = 'approved', approved_at = now(), approved_by_id = ${actor.userId}::uuid,
                        updated_at = now()
         WHERE id = ${versionId}::uuid AND status = 'draft'`;
      await tx.$executeRaw`
        UPDATE ${P} SET master_version_id = ${versionId}::uuid, updated_at = now()
         WHERE id = ${version.parent_id}::uuid`;
    });
    return this.versionDto(versionId);
  }

  // ------------------------------------------------------------------ helpers

  private async assertParentActive(parentId: string): Promise<void> {
    const parent = await this.loadParent(parentId);
    if (parent.archived_at) throw archived(this.kind.label);
  }

  private versionImmutable(): ApiError {
    return conflict(
      ApiErrorCode.VersionImmutable,
      'This version is approved and cannot be changed.',
    );
  }

  /** Why a guarded version UPDATE matched nothing: gone, approved meanwhile, or stale ETag. */
  private async explainVersionUpdate(versionId: string, db: Db = this.db): Promise<never> {
    const [row] = await db.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM ${this.kind.versionTable} WHERE id = ${versionId}::uuid`;
    if (!row) throw notFound('version');
    if (row.status === 'approved') throw this.versionImmutable();
    throw preconditionFailed();
  }

  private page<Row extends { created_at: Date; id: string }, Item>(
    rows: readonly Row[],
    limit: number,
    toItem: (row: Row) => Item,
  ): Page<Item> {
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      data: visible.map(toItem),
      page: {
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: last.created_at, id: last.id })
            : null,
        limit,
      },
    };
  }
}
