import { HttpStatus } from '@nestjs/common';

import {
  ApiErrorCode,
  type AspectRatio,
  type ContentBrief,
  type ContentItemDto,
} from '@acf/contracts';
import {
  isFormatCompatible,
  isMasterBriefStale,
  resolveVariantPlatform,
  type ChannelPlatform,
  type ContentFormat,
} from '@acf/content-domain';
import type { AspectRatio as DbAspectRatio, Prisma, TransactionClient } from '@acf/database';

import { ApiError } from '../common/api-error.js';
import { archived, referenceNotFound } from '../common/domain-errors.js';

/**
 * Content variants (R0, ADR-0015): helpers shared by the content and content-master services.
 * A content item is one variant of a content master.
 */

export const TO_DB_RATIO: Readonly<Record<AspectRatio, DbAspectRatio>> = {
  '9:16': 'ratio_9_16',
  '16:9': 'ratio_16_9',
  '1:1': 'ratio_1_1',
};
const FROM_DB_RATIO: Readonly<Record<DbAspectRatio, AspectRatio>> = {
  ratio_9_16: '9:16',
  ratio_16_9: '16:9',
  ratio_1_1: '1:1',
};

/** Relations every content item read includes, to report its platform and brief staleness. */
export const CONTENT_ITEM_LINKS = {
  channel: { select: { platform: true } },
  contentMaster: { select: { briefRevision: true } },
} as const satisfies Prisma.ContentItemInclude;

export type ContentItemRow = Prisma.ContentItemGetPayload<{ include: typeof CONTENT_ITEM_LINKS }>;

export function toContentItemDto(c: ContentItemRow): ContentItemDto {
  return {
    id: c.id,
    projectId: c.projectId,
    channelId: c.channelId,
    title: c.title,
    status: c.status,
    format: c.format,
    targetDurationSeconds: c.targetDurationSeconds,
    aspectRatio: FROM_DB_RATIO[c.aspectRatio],
    language: c.language,
    // Written only through the validated contract schema.
    brief: c.brief as ContentBrief,
    contentMasterId: c.contentMasterId,
    targetPlatform: c.channel?.platform ?? c.targetPlatform,
    masterBriefRevision: c.masterBriefRevision,
    masterBriefStale: isMasterBriefStale(c.masterBriefRevision, c.contentMaster.briefRevision),
    approvedScriptVersionId: c.approvedScriptVersionId,
    approvedStoryboardVersionId: c.approvedStoryboardVersionId,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** The channel must belong to the project (also enforced by the composite FK) and be active. */
export async function usableChannelPlatform(
  client: TransactionClient,
  projectId: string,
  channelId: string,
): Promise<ChannelPlatform> {
  const channel = await client.channel.findFirst({
    where: { id: channelId, projectId },
    select: { archivedAt: true, platform: true },
  });
  if (!channel) throw referenceNotFound('channel');
  if (channel.archivedAt) throw archived('channel');
  return channel.platform;
}

/**
 * The `target_platform` value to store: null when a channel is set (its platform applies),
 * otherwise the requested platform. Rejects a platform that contradicts the channel and a
 * format the effective platform does not accept.
 */
export function storedTargetPlatform(input: {
  readonly format: ContentFormat;
  readonly channelPlatform: ChannelPlatform | null;
  readonly targetPlatform: ChannelPlatform | null | undefined;
}): ChannelPlatform | null {
  const resolved = resolveVariantPlatform(input);
  if (!resolved.ok) {
    throw new ApiError({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ApiErrorCode.PlatformChannelMismatch,
      message: "The target platform differs from the channel's platform.",
      details: [
        { path: 'body.targetPlatform', message: "must be omitted or equal the channel's platform" },
      ],
    });
  }
  if (resolved.platform && !isFormatCompatible(input.format, resolved.platform)) {
    throw new ApiError({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ApiErrorCode.FormatPlatformIncompatible,
      message: 'The target platform does not accept this format.',
    });
  }
  return input.channelPlatform === null ? resolved.platform : null;
}
