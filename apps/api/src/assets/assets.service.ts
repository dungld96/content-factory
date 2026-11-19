import type { Readable } from 'node:stream';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  ApiErrorCode,
  type AssetDto,
  type AssetType,
  type AssetUsageDto,
  type LineageResponse,
  type Page,
  type RegisterAssetRequest,
  type UpdateAssetRequest,
  type UploadAssetQuery,
} from '@acf/contracts';
import { mediaTools, type ApiEnv } from '@acf/config';
import {
  inspectAudio,
  MediaToolsMissingError,
  MediaValidationError,
  type InspectedAudio,
} from '@acf/media';
import {
  assetObjectKey,
  ImageValidationError,
  inspectImage,
  uuidv7,
  type ByteRange,
  type ObjectBody,
} from '@acf/storage';
import { Prisma, type Asset } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { definedOnly } from '../common/defined-only.js';
import {
  archived,
  guardedUpdateFailure,
  notFound,
  referenceNotFound,
} from '../common/domain-errors.js';
import { validationError } from '../common/http/endpoint.js';
import { keysetAfter, NEWEST_FIRST, toPage } from '../common/http/pagination.js';
import { API_ENV } from '../config/api-config.module.js';
import { ObjectStoreService, storageFailure } from '../infrastructure/object-store.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { TransactionRunner } from '../infrastructure/transaction-runner.js';
import { ProjectAccess } from '../projects/project-access.service.js';

const { sql, empty } = Prisma;

export function toAssetDto(a: Asset): AssetDto {
  return {
    id: a.id,
    projectId: a.projectId,
    contentItemId: a.contentItemId,
    assetType: a.assetType,
    sourceType: a.sourceType,
    sourceAssetId: a.sourceAssetId,
    sourceNote: a.sourceNote,
    storageKey: a.storageKey,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes), // ≤ 10 GiB by contract: exact as a JS number
    checksumSha256: a.checksumSha256,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    originalFilename: a.originalFilename,
    label: a.label,
    metadata: a.metadata as Record<string, unknown>,
    approvalStatus: a.approvalStatus,
    reviewedById: a.reviewedById,
    reviewedAt: a.reviewedAt?.toISOString() ?? null,
    generationJobId: a.generationJobId,
    storyboardSceneId: a.storyboardSceneId,
    archivedAt: a.archivedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Raw lineage rows use snake_case; map them onto the Prisma `Asset` shape. */
interface AssetRow {
  id: string;
  project_id: string;
  content_item_id: string | null;
  asset_type: Asset['assetType'];
  source_type: Asset['sourceType'];
  source_asset_id: string | null;
  source_note: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: bigint;
  checksum_sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  original_filename: string | null;
  label: string | null;
  metadata: Prisma.JsonValue;
  approval_status: Asset['approvalStatus'];
  reviewed_by_id: string | null;
  reviewed_at: Date | null;
  generation_job_id: string | null;
  storyboard_scene_id: string | null;
  created_by_id: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  depth: number;
}

const fromRow = (r: AssetRow): Asset => ({
  id: r.id,
  projectId: r.project_id,
  contentItemId: r.content_item_id,
  assetType: r.asset_type,
  sourceType: r.source_type,
  sourceAssetId: r.source_asset_id,
  sourceNote: r.source_note,
  storageKey: r.storage_key,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  checksumSha256: r.checksum_sha256,
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms,
  originalFilename: r.original_filename,
  label: r.label,
  metadata: r.metadata,
  approvalStatus: r.approval_status,
  reviewedById: r.reviewed_by_id,
  reviewedAt: r.reviewed_at,
  generationJobId: r.generation_job_id,
  storyboardSceneId: r.storyboard_scene_id,
  createdById: r.created_by_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const ASSET_COLUMNS = sql`a.id, a.project_id, a.content_item_id, a.asset_type::text AS asset_type,
  a.source_type::text AS source_type, a.source_asset_id, a.source_note, a.storage_key, a.mime_type,
  a.size_bytes, a.checksum_sha256, a.width, a.height, a.duration_ms, a.original_filename, a.label,
  a.metadata, a.approval_status::text AS approval_status, a.reviewed_by_id, a.reviewed_at,
  a.generation_job_id, a.storyboard_scene_id, a.created_by_id, a.archived_at,
  a.created_at, a.updated_at`;

const lineageCursorSchema = z.strictObject({ d: z.number().int().min(1), i: z.uuid() });

function encodeLineageCursor(depth: number, id: string): string {
  return Buffer.from(JSON.stringify({ d: depth, i: id }), 'utf8').toString('base64url');
}

function decodeLineageCursor(cursor: string): { depth: number; id: string } {
  try {
    const parsed = lineageCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { depth: parsed.d, id: parsed.i };
  } catch {
    throw new ApiError({
      status: HttpStatus.BAD_REQUEST,
      code: ApiErrorCode.InvalidCursor,
      message: 'The pagination cursor is invalid.',
    });
  }
}

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: TransactionRunner,
    private readonly access: ProjectAccess,
    private readonly storage: ObjectStoreService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  /** Metadata-only registration (decision D8); bytes arrive via presigned upload in M4. */
  async register(actor: Actor, projectId: string, input: RegisterAssetRequest): Promise<AssetDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    if (!input.storageKey.startsWith(`projects/${projectId}/`)) {
      throw validationError([
        { path: 'body.storageKey', message: `must start with projects/${projectId}/` },
      ]);
    }
    if (input.sourceAssetId) {
      const source = await this.db.asset.findFirst({
        where: { id: input.sourceAssetId, projectId },
        select: { id: true },
      });
      if (!source) throw referenceNotFound('source asset');
    }
    if (input.contentItemId) {
      const item = await this.db.contentItem.findFirst({
        where: { id: input.contentItemId, projectId },
        select: { archivedAt: true },
      });
      if (!item) throw referenceNotFound('content item');
      if (item.archivedAt) throw archived('content item');
    }
    const asset = await this.db.asset.create({
      data: {
        projectId,
        assetType: input.assetType,
        sourceType: input.sourceType,
        sourceAssetId: input.sourceAssetId ?? null,
        sourceNote: input.sourceNote ?? null,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        checksumSha256: input.checksumSha256,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        originalFilename: input.originalFilename ?? null,
        contentItemId: input.contentItemId ?? null,
        label: input.label ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
        createdById: actor.userId,
      },
    });
    return toAssetDto(asset);
  }

  /**
   * Raw-body upload (M4 design §4.2, M5 §7.3): validate the bytes (magic bytes decide the type;
   * FFprobe for audio), write them write-once under a content-addressed key, then insert the
   * asset. A failed insert leaves a private orphan object (swept in M7).
   */
  async upload(
    actor: Actor,
    projectId: string,
    query: UploadAssetQuery,
    request: { readonly headers: Record<string, string | string[] | undefined> } & Readable,
  ): Promise<AssetDto> {
    await this.access.require(actor, projectId, 'editor', { mutation: true });
    const store = this.storage.require();
    if (query.contentItemId) {
      const item = await this.db.contentItem.findFirst({
        where: { id: query.contentItemId, projectId },
        select: { archivedAt: true },
      });
      if (!item) throw referenceNotFound('content item');
      if (item.archivedAt) throw archived('content item');
    }
    if (query.assetType === 'audio' && query.purpose === 'music' && !query.licenseNote) {
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.LicenseNoteRequired,
        message: 'Music needs a licence note: where it comes from and its terms of use.',
      });
    }
    const audio = query.assetType === 'audio';
    const limit = audio ? this.env.UPLOAD_MAX_AUDIO_BYTES : this.env.UPLOAD_MAX_IMAGE_BYTES;
    const kind = audio ? 'audio' : 'image';
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > limit)
      throw mediaError('MEDIA_TOO_LARGE', kind);
    const bytes = await readBody(request, limit, kind);
    const header = request.headers['content-type'];
    const contentType = typeof header === 'string' ? header : null;

    let file: {
      mimeType: Parameters<typeof assetObjectKey>[0]['mimeType'];
      sizeBytes: number;
      sha256Hex: string;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      metadata: Prisma.InputJsonObject;
    };
    if (audio) {
      const inspected = await this.inspectAudio(bytes, contentType, limit);
      file = {
        ...inspected,
        width: null,
        height: null,
        metadata: {
          purpose: query.purpose ?? null,
          audio: {
            codec: inspected.codec,
            sampleRate: inspected.sampleRate,
            channels: inspected.channels,
            bitRate: inspected.bitRate,
          },
        },
      };
    } else {
      let image;
      try {
        image = inspectImage(bytes, contentType, { maxBytes: limit });
      } catch (error) {
        if (error instanceof ImageValidationError) {
          throw mediaError(error.code, 'image', error.message);
        }
        throw error;
      }
      file = { ...image, durationMs: null, metadata: {} };
    }

    const id = uuidv7();
    const storageKey = assetObjectKey({
      projectId,
      assetId: id,
      sha256Hex: file.sha256Hex,
      mimeType: file.mimeType,
    });
    try {
      await store.putIfAbsent(storageKey, bytes, {
        contentType: file.mimeType,
        sha256Hex: file.sha256Hex,
      });
    } catch (error) {
      storageFailure(error);
    }
    const asset = await this.db.asset.create({
      data: {
        id,
        projectId,
        assetType: query.assetType,
        sourceType: 'upload',
        sourceNote: query.licenseNote ?? null,
        storageKey,
        mimeType: file.mimeType,
        sizeBytes: BigInt(file.sizeBytes),
        checksumSha256: file.sha256Hex,
        width: file.width,
        height: file.height,
        durationMs: file.durationMs,
        originalFilename: query.filename ?? null,
        contentItemId: query.contentItemId ?? null,
        label: query.label ?? null,
        metadata: file.metadata,
        createdById: actor.userId,
      },
    });
    return toAssetDto(asset);
  }

  private async inspectAudio(
    bytes: Uint8Array,
    contentType: string | null,
    limit: number,
  ): Promise<InspectedAudio> {
    try {
      return await inspectAudio(bytes, contentType, {
        maxBytes: limit,
        tools: mediaTools(this.env),
      });
    } catch (error) {
      if (error instanceof MediaValidationError)
        throw mediaError(error.code, 'audio', error.message);
      if (error instanceof MediaToolsMissingError) throw mediaToolsMissing();
      throw error;
    }
  }

  /**
   * The asset's bytes, for streaming (viewer+). `range` = one satisfiable byte range of the file
   * (resolved by the controller against `asset.sizeBytes`); absent = the whole object.
   */
  async content(
    actor: Actor,
    assetId: string,
    range?: (asset: Asset) => ByteRange | undefined,
  ): Promise<{ readonly asset: Asset; readonly body: ObjectBody; readonly range?: ByteRange }> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'viewer');
    const store = this.storage.require();
    const wanted = range?.(asset);
    let body: ObjectBody | null;
    try {
      body = await store.get(asset.storageKey, wanted);
    } catch (error) {
      storageFailure(error);
    }
    if (!body) {
      throw new ApiError({
        status: HttpStatus.NOT_FOUND,
        code: ApiErrorCode.AssetContentMissing,
        message: 'The asset is registered, but its file is not in storage.',
      });
    }
    return wanted ? { asset, body, range: wanted } : { asset, body };
  }

  async list(
    actor: Actor,
    projectId: string,
    query: {
      limit: number;
      cursor?: string | undefined;
      includeArchived: boolean;
      assetType?: AssetType | undefined;
      contentItemId?: string | undefined;
    },
  ): Promise<Page<AssetDto>> {
    await this.access.require(actor, projectId, 'viewer');
    const rows = await this.db.asset.findMany({
      where: {
        projectId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.assetType ? { assetType: query.assetType } : {}),
        ...(query.contentItemId ? { contentItemId: query.contentItemId } : {}),
        ...keysetAfter(query.cursor),
      },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, toAssetDto);
  }

  async get(actor: Actor, assetId: string): Promise<AssetDto> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'viewer');
    return toAssetDto(asset);
  }

  async update(
    actor: Actor,
    assetId: string,
    input: UpdateAssetRequest,
    expected: Date | undefined,
  ): Promise<AssetDto> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'editor', { mutation: true });
    const { count } = await this.db.asset.updateMany({
      where: { id: assetId, archivedAt: null, ...(expected ? { updatedAt: expected } : {}) },
      data: definedOnly({
        label: input.label,
        metadata: input.metadata as Prisma.InputJsonObject | undefined,
      }),
    });
    const current = await this.db.asset.findUnique({ where: { id: assetId } });
    if (count === 0 || !current) throw guardedUpdateFailure(current, 'asset');
    return toAssetDto(current);
  }

  /**
   * Design package §7: lock only the asset row (it waits for an approval holding it), re-read
   * usages, then archive. The trigger re-checks (AC008).
   */
  async archive(actor: Actor, assetId: string): Promise<AssetDto> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'editor', { mutation: true });
    await this.runner.run('asset.archive', async (tx) => {
      const [locked] = await tx.$queryRaw<{ archived_at: Date | null }[]>`
        SELECT archived_at FROM assets WHERE id = ${assetId}::uuid FOR NO KEY UPDATE`;
      if (!locked) throw notFound('asset');
      if (locked.archived_at) throw archived('asset');
      const [usage] = await tx.$queryRaw<{ used: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM character_versions WHERE primary_asset_id = ${assetId}::uuid AND status = 'approved')
            OR EXISTS (SELECT 1 FROM environment_versions WHERE primary_asset_id = ${assetId}::uuid AND status = 'approved')
            OR EXISTS (SELECT 1 FROM character_version_assets l JOIN character_versions v ON v.id = l.character_version_id
                        WHERE l.asset_id = ${assetId}::uuid AND v.status = 'approved')
            OR EXISTS (SELECT 1 FROM environment_version_assets l JOIN environment_versions v ON v.id = l.environment_version_id
                        WHERE l.asset_id = ${assetId}::uuid AND v.status = 'approved') AS used`;
      if (usage?.used) {
        throw new ApiError({
          status: HttpStatus.CONFLICT,
          code: ApiErrorCode.AssetInUse,
          message: 'The asset is used by an approved version and cannot be archived.',
        });
      }
      await tx.asset.update({ where: { id: assetId }, data: { archivedAt: new Date() } });
    });
    return toAssetDto(await this.load(assetId));
  }

  /** Design package §4.3: bounded recursive traversal in either direction. */
  async lineage(
    actor: Actor,
    assetId: string,
    query: {
      direction: 'ancestors' | 'descendants';
      depth: number;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<LineageResponse> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'viewer');

    if (query.direction === 'ancestors') {
      // Follows primary keys upward; a chain, so no pagination is needed.
      const rows = await this.db.$queryRaw<AssetRow[]>`
        WITH RECURSIVE chain AS (
          SELECT source_asset_id AS next_id, 1 AS depth FROM assets WHERE id = ${assetId}::uuid
          UNION ALL
          SELECT a.source_asset_id, c.depth + 1 FROM chain c JOIN assets a ON a.id = c.next_id
           WHERE c.depth < ${query.depth})
        SELECT ${ASSET_COLUMNS}, c.depth FROM chain c JOIN assets a ON a.id = c.next_id
         ORDER BY c.depth`;
      return {
        direction: 'ancestors',
        data: rows.map((r) => ({ depth: r.depth, asset: toAssetDto(fromRow(r)) })),
        page: { nextCursor: null, limit: rows.length },
      };
    }

    // Descendants fan out (index on source_asset_id): breadth-first, keyset on (depth, id).
    const after = query.cursor === undefined ? undefined : decodeLineageCursor(query.cursor);
    const rows = await this.db.$queryRaw<AssetRow[]>`
      WITH RECURSIVE tree AS (
        SELECT id, 1 AS depth FROM assets WHERE source_asset_id = ${assetId}::uuid
        UNION ALL
        SELECT a.id, t.depth + 1 FROM tree t JOIN assets a ON a.source_asset_id = t.id
         WHERE t.depth < ${query.depth})
      SELECT ${ASSET_COLUMNS}, t.depth FROM tree t JOIN assets a ON a.id = t.id
       WHERE true ${after ? sql`AND (t.depth, a.id) > (${after.depth}, ${after.id}::uuid)` : empty}
       ORDER BY t.depth, a.id
       LIMIT ${query.limit + 1}`;
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      direction: 'descendants',
      data: visible.map((r) => ({ depth: r.depth, asset: toAssetDto(fromRow(r)) })),
      page: {
        nextCursor:
          rows.length > query.limit && last ? encodeLineageCursor(last.depth, last.id) : null,
        limit: query.limit,
      },
    };
  }

  /** Versions referencing the asset, as primary or linked asset (design package §4.3). */
  async usages(actor: Actor, assetId: string): Promise<{ data: AssetUsageDto[] }> {
    const asset = await this.load(assetId);
    await this.access.require(actor, asset.projectId, 'viewer');
    const rows = await this.db.$queryRaw<
      {
        kind: 'character' | 'environment';
        parent_id: string;
        version_id: string;
        version: number;
        status: 'draft' | 'approved';
        reference: 'primary' | 'link';
      }[]
    >`
      SELECT 'character' AS kind, v.character_id AS parent_id, v.id AS version_id, v.version,
             v.status::text AS status, 'primary' AS reference
        FROM character_versions v WHERE v.primary_asset_id = ${assetId}::uuid
      UNION ALL
      SELECT 'character', v.character_id, v.id, v.version, v.status::text, 'link'
        FROM character_version_assets l JOIN character_versions v ON v.id = l.character_version_id
       WHERE l.asset_id = ${assetId}::uuid
      UNION ALL
      SELECT 'environment', v.environment_id, v.id, v.version, v.status::text, 'primary'
        FROM environment_versions v WHERE v.primary_asset_id = ${assetId}::uuid
      UNION ALL
      SELECT 'environment', v.environment_id, v.id, v.version, v.status::text, 'link'
        FROM environment_version_assets l JOIN environment_versions v ON v.id = l.environment_version_id
       WHERE l.asset_id = ${assetId}::uuid
      ORDER BY kind, parent_id, version, reference`;
    return {
      data: rows.map((r) => ({
        kind: r.kind,
        parentId: r.parent_id,
        versionId: r.version_id,
        version: r.version,
        status: r.status,
        reference: r.reference,
      })),
    };
  }

  private async load(assetId: string): Promise<Asset> {
    const asset = await this.db.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw notFound('asset');
    return asset;
  }
}

const MEDIA_ERRORS = {
  UNSUPPORTED_MEDIA: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    code: ApiErrorCode.UnsupportedMedia,
  },
  MEDIA_TOO_LARGE: { status: HttpStatus.PAYLOAD_TOO_LARGE, code: ApiErrorCode.MediaTooLarge },
  MEDIA_INVALID: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: ApiErrorCode.MediaInvalid },
  MEDIA_TYPE_MISMATCH: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    code: ApiErrorCode.MediaTypeMismatch,
  },
} as const;

function mediaError(
  code: keyof typeof MEDIA_ERRORS,
  kind: 'image' | 'audio',
  detail?: string,
): ApiError {
  const { status, code: apiCode } = MEDIA_ERRORS[code];
  const message =
    code === 'MEDIA_TOO_LARGE'
      ? `The ${kind} is too large.`
      : code === 'UNSUPPORTED_MEDIA'
        ? kind === 'image'
          ? 'Only PNG, JPEG and WebP images are accepted.'
          : 'Only MP3, WAV and M4A/AAC audio is accepted.'
        : code === 'MEDIA_TYPE_MISMATCH'
          ? 'The Content-Type does not match the file.'
          : `The ${kind} cannot be read.`;
  return new ApiError({
    status,
    code: apiCode,
    message: detail ? `${message} (${detail})` : message,
  });
}

/** FFprobe/FFmpeg is not installed (CLAUDE.md §8; M5 design §8). */
export function mediaToolsMissing(): ApiError {
  return new ApiError({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ApiErrorCode.MediaToolsMissing,
    message: 'Media tools (FFprobe/FFmpeg) are not installed on this server.',
  });
}

/** Reads the raw request body, failing with 413 as soon as it exceeds `limit` bytes. */
async function readBody(
  stream: Readable,
  limit: number,
  kind: 'image' | 'audio',
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > limit) {
      stream.resume(); // drain without keeping the bytes
      throw mediaError('MEDIA_TOO_LARGE', kind);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
