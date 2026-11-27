import { z } from 'zod';

import {
  includeArchivedSchema,
  isoDateTimeSchema,
  optionalTextSchema,
  slugSchema,
} from './common.js';

export const channelPlatformSchema = z
  .enum(['tiktok', 'instagram_reels', 'youtube_shorts', 'other'])
  .meta({ id: 'ChannelPlatform' });

export const channelIdParamsSchema = z.strictObject({ channelId: z.uuid() });

export const createChannelRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    /** Unique within the project. */
    slug: slugSchema,
    platform: channelPlatformSchema,
    handle: optionalTextSchema(120).optional(),
    description: optionalTextSchema(5000).optional(),
  })
  .meta({ id: 'CreateChannelRequest' });
export type CreateChannelRequest = z.output<typeof createChannelRequestSchema>;

export const updateChannelRequestSchema = createChannelRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateChannelRequest' });
export type UpdateChannelRequest = z.output<typeof updateChannelRequestSchema>;

export const channelSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    platform: channelPlatformSchema,
    handle: z.string().nullable(),
    description: z.string().nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Channel' });
export type ChannelDto = z.infer<typeof channelSchema>;

export const listChannelsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
});
