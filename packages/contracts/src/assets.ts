import { z } from 'zod';

import { includeArchivedSchema, isoDateTimeSchema } from './common.js';

export const assetTypeSchema = z
  .enum(['reference', 'image', 'video', 'audio', 'subtitle', 'render'])
  .meta({ id: 'AssetType' });
export type AssetType = z.infer<typeof assetTypeSchema>;

/** `generated` is reserved for provider jobs (M4) and cannot be registered in M1. */
export const assetSourceTypeSchema = z
  .enum(['upload', 'import', 'generated', 'derived'])
  .meta({ id: 'AssetSourceType' });
export const registrableSourceTypeSchema = z.enum(['upload', 'import', 'derived']);

export const approvalStatusSchema = z
  .enum(['pending', 'approved', 'rejected', 'changes_requested'])
  .meta({ id: 'ApprovalStatus' });

/** MIME types accepted per asset type (CLAUDE.md §8: validate MIME type). */
export const ASSET_MIME_TYPES: Readonly<Record<AssetType, readonly string[]>> = {
  reference: ['image/png', 'image/jpeg', 'image/webp'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/ogg'],
  subtitle: ['text/vtt', 'application/x-subrip'],
  render: ['video/mp4'],
};

/** Upper bound on a registered file (10 GiB). Bytes arrive via presigned upload in M4. */
export const ASSET_MAX_SIZE_BYTES = 10 * 1024 ** 3;

const jsonObject = (maxBytes: number) =>
  z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= maxBytes, {
    message: `must serialize to at most ${maxBytes} bytes`,
  });

export const assetIdParamsSchema = z.strictObject({ assetId: z.uuid() });

/** Image types accepted by `POST /projects/:projectId/assets/upload` (M4a; magic bytes decide). */
export const UPLOADABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Query of the raw-body image upload (M4 design §4.2); the body is the image itself. */
export const uploadAssetQuerySchema = z.strictObject({
  assetType: z.enum(['reference', 'image']),
  filename: z.string().trim().min(1).max(255).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  contentItemId: z.uuid().optional(),
});
export type UploadAssetQuery = z.output<typeof uploadAssetQuerySchema>;

/** Metadata-only registration (decision D8). */
export const registerAssetRequestSchema = z
  .strictObject({
    assetType: assetTypeSchema,
    sourceType: registrableSourceTypeSchema,
    /** Required for `derived`; must be an asset of the same project. */
    sourceAssetId: z.uuid().optional(),
    sourceNote: z.string().trim().min(1).max(1000).optional(),
    /** Object-storage key; must start with `projects/<projectId>/`. */
    storageKey: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9!_.*'()\-/]+$/, 'must contain only URL-safe object-key characters')
      .refine((key) => !key.split('/').some((part) => part === '..' || part === '.'), {
        message: 'must not contain . or .. segments',
      }),
    mimeType: z.string().trim().toLowerCase().max(255),
    sizeBytes: z.number().int().min(0).max(ASSET_MAX_SIZE_BYTES),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters'),
    width: z.number().int().min(1).max(65_535).optional(),
    height: z.number().int().min(1).max(65_535).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    originalFilename: z.string().trim().min(1).max(255).optional(),
    contentItemId: z.uuid().optional(),
    label: z.string().trim().min(1).max(200).optional(),
    metadata: jsonObject(20_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (!ASSET_MIME_TYPES[value.assetType].includes(value.mimeType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: `must be one of ${ASSET_MIME_TYPES[value.assetType].join(', ')} for ${value.assetType}`,
      });
    }
    if (value.sourceType === 'derived' && !value.sourceAssetId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceAssetId'],
        message: 'is required for derived assets',
      });
    }
  })
  .meta({ id: 'RegisterAssetRequest' });
export type RegisterAssetRequest = z.output<typeof registerAssetRequestSchema>;

/** Only descriptive fields are mutable; file identity and provenance never change (AC005). */
export const updateAssetRequestSchema = z
  .strictObject({
    label: z
      .string()
      .trim()
      .max(200)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    metadata: jsonObject(20_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateAssetRequest' });
export type UpdateAssetRequest = z.output<typeof updateAssetRequestSchema>;

export const assetSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    contentItemId: z.uuid().nullable(),
    assetType: assetTypeSchema,
    sourceType: assetSourceTypeSchema,
    sourceAssetId: z.uuid().nullable(),
    sourceNote: z.string().nullable(),
    storageKey: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int(),
    checksumSha256: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    originalFilename: z.string().nullable(),
    label: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    approvalStatus: approvalStatusSchema,
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Asset' });
export type AssetDto = z.infer<typeof assetSchema>;

export const listAssetsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
  assetType: assetTypeSchema.optional(),
  contentItemId: z.uuid().optional(),
});

export const LINEAGE_MAX_DEPTH = 50;

export const lineageQuerySchema = z.strictObject({
  direction: z.enum(['ancestors', 'descendants']).default('ancestors'),
  depth: z.coerce.number().int().min(1).max(LINEAGE_MAX_DEPTH).default(LINEAGE_MAX_DEPTH),
  /** Descendants only. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const lineageNodeSchema = z
  .object({ depth: z.number().int(), asset: assetSchema })
  .meta({ id: 'LineageNode' });

export const lineageResponseSchema = z
  .object({
    direction: z.enum(['ancestors', 'descendants']),
    data: z.array(lineageNodeSchema),
    page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
  })
  .meta({ id: 'LineageResponse' });
export type LineageResponse = z.infer<typeof lineageResponseSchema>;

export const assetUsageSchema = z
  .object({
    kind: z.enum(['character', 'environment']),
    parentId: z.uuid(),
    versionId: z.uuid(),
    version: z.number().int(),
    status: z.enum(['draft', 'approved']),
    reference: z.enum(['primary', 'link']),
  })
  .meta({ id: 'AssetUsage' });
export type AssetUsageDto = z.infer<typeof assetUsageSchema>;
