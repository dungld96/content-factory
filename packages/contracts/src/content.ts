import { z } from 'zod';

import { channelPlatformSchema } from './channels.js';
import { includeArchivedSchema, isoDateTimeSchema, languageTagSchema } from './common.js';

/** Canonical list per docs/CONTENT_PIPELINE.md §2 (decision U1). M1 creates `draft` only. */
export const contentStatusSchema = z
  .enum([
    'draft',
    'researching',
    'planning',
    'scripting',
    'script_review',
    'storyboarding',
    'storyboard_review',
    'generating_assets',
    'asset_review',
    'rendering',
    'quality_review',
    'approved',
    'exported',
    'failed',
    'canceled',
    'needs_input',
  ])
  .meta({ id: 'ContentStatus' });
export type ContentStatus = z.infer<typeof contentStatusSchema>;

export const contentFormatSchema = z.enum(['short_video']).meta({ id: 'ContentFormat' });
export const aspectRatioSchema = z.enum(['9:16', '16:9', '1:1']).meta({ id: 'AspectRatio' });
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

/** Product reference images per brief (each keyframe also takes character/environment/scene refs). */
export const PRODUCT_REFERENCES_MAX = 4;

const text = (max: number) => z.string().trim().min(1).max(max);

/** Content brief (docs/CONTENT_PIPELINE.md stage 1). */
export const contentBriefSchema = z
  .strictObject({
    topic: text(500),
    audience: text(500).optional(),
    objective: text(500).optional(),
    tone: text(200).optional(),
    callToAction: text(500).optional(),
    notes: text(5000).optional(),
    sourceUrls: z
      .array(z.url({ protocol: /^https?$/ }).max(2048))
      .max(20)
      .optional(),
    /** Recurring character of the same project; its approved master is used (M3). */
    characterId: z.uuid().optional(),
    /** Fixed environment of the same project; its approved master is used (M3). */
    environmentId: z.uuid().optional(),
    /**
     * Product (subject) photos from the project's Library: sent as reference images with every
     * keyframe, so the product looks the same in every scene (e.g. the reviewed device).
     */
    productAssetIds: z.array(z.uuid()).min(1).max(PRODUCT_REFERENCES_MAX).optional(),
  })
  .meta({ id: 'ContentBrief' });
export type ContentBrief = z.infer<typeof contentBriefSchema>;

export const contentIdParamsSchema = z.strictObject({ contentId: z.uuid() });

export const createContentRequestSchema = z
  .strictObject({
    title: text(200),
    /** A channel of the same project, or omitted. */
    channelId: z.uuid().nullable().optional(),
    format: contentFormatSchema,
    targetDurationSeconds: z.number().int().min(1).max(600),
    aspectRatio: aspectRatioSchema,
    language: languageTagSchema,
    brief: contentBriefSchema,
    /**
     * Target platform for a variant without a channel (R0). With a channel, the channel's
     * platform applies and this must be omitted, null or equal to it.
     */
    targetPlatform: channelPlatformSchema.nullable().optional(),
  })
  .meta({ id: 'CreateContentRequest' });
export type CreateContentRequest = z.output<typeof createContentRequestSchema>;

/** `status` and `format` are not client-writable. */
export const updateContentRequestSchema = createContentRequestSchema
  .omit({ format: true })
  .extend({
    /** Voice profile of the same project for voice-overs (M5 §7.1); null clears it. */
    voiceProfileId: z.uuid().nullable(),
    /** P4d: false skips the voice-over stage (no TTS cost); renders have no voice. */
    voiceEnabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateContentRequest' });
export type UpdateContentRequest = z.output<typeof updateContentRequestSchema>;

export const contentItemSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    channelId: z.uuid().nullable(),
    title: z.string(),
    status: contentStatusSchema,
    format: contentFormatSchema,
    targetDurationSeconds: z.number().int(),
    aspectRatio: aspectRatioSchema,
    language: z.string(),
    brief: contentBriefSchema,
    /** The content master this item (a variant) belongs to (R0). */
    contentMasterId: z.uuid(),
    /** Effective target platform: the channel's when a channel is set, else the item's own. */
    targetPlatform: channelPlatformSchema.nullable(),
    /** The master brief revision this item's brief was copied from. */
    masterBriefRevision: z.number().int().min(1),
    /** True when the master's brief changed after this item copied it (resync to update). */
    masterBriefStale: z.boolean(),
    /** Gate 1: the approved script in use (M3). */
    approvedScriptVersionId: z.uuid().nullable(),
    /** Gate 2: the approved storyboard (M3). */
    approvedStoryboardVersionId: z.uuid().nullable(),
    /** Voice profile used for voice-overs (M5). */
    voiceProfileId: z.uuid().nullable(),
    /** P4d: whether this item has a voice-over at all. */
    voiceEnabled: z.boolean(),
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'ContentItem' });
export type ContentItemDto = z.infer<typeof contentItemSchema>;

export const listContentQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
  channelId: z.uuid().optional(),
  status: contentStatusSchema.optional(),
});
