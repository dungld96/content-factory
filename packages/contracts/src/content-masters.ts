import { z } from 'zod';

import { channelPlatformSchema } from './channels.js';
import { includeArchivedSchema, isoDateTimeSchema, languageTagSchema } from './common.js';
import {
  aspectRatioSchema,
  contentBriefSchema,
  contentFormatSchema,
  contentItemSchema,
} from './content.js';

/**
 * Content masters and variants (R0; docs/design/M3.5-multiformat-architecture-review.md §5.3,
 * ADR-0015). A master holds the shared brief; each content item is one variant of a master.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const contentMasterIdParamsSchema = z.strictObject({ masterId: z.uuid() });

export const createContentMasterRequestSchema = z
  .strictObject({
    title: text(200),
    brief: contentBriefSchema,
    /** Default language of new variants (BCP 47). */
    language: languageTagSchema,
  })
  .meta({ id: 'CreateContentMasterRequest' });
export type CreateContentMasterRequest = z.output<typeof createContentMasterRequestSchema>;

/** A brief change increments `briefRevision`; existing variants then report `masterBriefStale`. */
export const updateContentMasterRequestSchema = createContentMasterRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateContentMasterRequest' });
export type UpdateContentMasterRequest = z.output<typeof updateContentMasterRequestSchema>;

/** A new variant copies the master's brief; title and language default to the master's. */
export const createVariantRequestSchema = z
  .strictObject({
    title: text(200).optional(),
    format: contentFormatSchema,
    channelId: z.uuid().nullable().optional(),
    targetPlatform: channelPlatformSchema.nullable().optional(),
    targetDurationSeconds: z.number().int().min(1).max(600),
    aspectRatio: aspectRatioSchema,
    language: languageTagSchema.optional(),
  })
  .meta({ id: 'CreateVariantRequest' });
export type CreateVariantRequest = z.output<typeof createVariantRequestSchema>;

export const contentMasterSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    title: z.string(),
    brief: contentBriefSchema,
    briefRevision: z.number().int().min(1),
    language: z.string(),
    /** Variants that are not archived. */
    activeVariantCount: z.number().int().min(0),
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'ContentMaster' });
export type ContentMasterDto = z.infer<typeof contentMasterSchema>;

/** A master with all of its variants (archived included), newest first. */
export const contentMasterDetailSchema = contentMasterSchema
  .extend({ variants: z.array(contentItemSchema) })
  .meta({ id: 'ContentMasterDetail' });
export type ContentMasterDetailDto = z.infer<typeof contentMasterDetailSchema>;

export const listContentMastersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
});
