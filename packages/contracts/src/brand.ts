import { z } from 'zod';

import {
  includeArchivedSchema,
  isoDateTimeSchema,
  optionalTextSchema,
  slugSchema,
} from './common.js';

// Characters and environments share one shape (design package §8.2: "same nine shapes").

export const versionStatusSchema = z.enum(['draft', 'approved']).meta({ id: 'VersionStatus' });

const rulesSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 50_000, {
    message: 'must serialize to at most 50000 bytes',
  });

export const createVersionedEntityRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    /** Unique within the project. */
    slug: slugSchema,
    description: optionalTextSchema(5000).optional(),
  })
  .meta({ id: 'CreateVersionedEntityRequest' });
export type CreateVersionedEntityRequest = z.output<typeof createVersionedEntityRequestSchema>;

/** The master pointer is never client-writable (it moves only on approval). */
export const updateVersionedEntityRequestSchema = createVersionedEntityRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateVersionedEntityRequest' });
export type UpdateVersionedEntityRequest = z.output<typeof updateVersionedEntityRequestSchema>;

export const versionSummarySchema = z
  .object({ id: z.uuid(), version: z.number().int(), approvedAt: isoDateTimeSchema })
  .meta({ id: 'VersionSummary' });

export const versionedEntitySchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    /** The master: the highest-numbered approved version (decision D1). */
    master: versionSummarySchema.nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'VersionedEntity' });
export type VersionedEntityDto = z.infer<typeof versionedEntitySchema>;

export const versionAssetLinkSchema = z
  .strictObject({
    assetId: z.uuid(),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .meta({ id: 'VersionAssetLink' });
export type VersionAssetLink = z.output<typeof versionAssetLinkSchema>;

const linkListSchema = z
  .array(versionAssetLinkSchema)
  .max(50)
  .refine((links) => new Set(links.map((l) => l.assetId)).size === links.length, {
    message: 'asset ids must be unique',
  });

export const createVersionRequestSchema = z
  .strictObject({
    /** Copy description, rules, primary asset and links from this version of the same parent. */
    basedOnVersionId: z.uuid().optional(),
    /** Required unless `basedOnVersionId` is given. */
    description: z.string().trim().min(1).max(10_000).optional(),
    rules: rulesSchema.optional(),
    primaryAssetId: z.uuid().nullable().optional(),
    assets: linkListSchema.optional(),
  })
  .refine((v) => v.basedOnVersionId !== undefined || v.description !== undefined, {
    message: 'description is required unless basedOnVersionId is given',
    path: ['description'],
  })
  .meta({ id: 'CreateVersionRequest' });
export type CreateVersionRequest = z.output<typeof createVersionRequestSchema>;

export const updateVersionRequestSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(10_000).optional(),
    rules: rulesSchema.optional(),
    primaryAssetId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateVersionRequest' });
export type UpdateVersionRequest = z.output<typeof updateVersionRequestSchema>;

export const replaceVersionAssetsRequestSchema = z
  .strictObject({ assets: linkListSchema })
  .meta({ id: 'ReplaceVersionAssetsRequest' });
export type ReplaceVersionAssetsRequest = z.output<typeof replaceVersionAssetsRequestSchema>;

export const versionSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    /** The character or environment this version belongs to. */
    parentId: z.uuid(),
    version: z.number().int(),
    status: versionStatusSchema,
    description: z.string(),
    /** `identityRules` for characters, `visualRules` for environments. */
    rules: z.record(z.string(), z.unknown()),
    primaryAssetId: z.uuid().nullable(),
    basedOnVersionId: z.uuid().nullable(),
    createdById: z.uuid(),
    approvedById: z.uuid().nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    assets: z.array(
      z.object({ assetId: z.uuid(), sortOrder: z.number().int(), note: z.string().nullable() }),
    ),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Version' });
export type VersionDto = z.infer<typeof versionSchema>;

export const listVersionedEntitiesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
});

export const listVersionsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

export const characterIdParamsSchema = z.strictObject({ characterId: z.uuid() });
export const environmentIdParamsSchema = z.strictObject({ environmentId: z.uuid() });
export const versionIdParamsSchema = z.strictObject({ versionId: z.uuid() });
