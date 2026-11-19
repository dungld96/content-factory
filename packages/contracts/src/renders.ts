import { z } from 'zod';

import { usdAmountSchema } from './ai.js';
import { assetSchema } from './assets.js';
import { isoDateTimeSchema } from './common.js';
import { generationJobSchema } from './generation.js';

/**
 * Renders and export (M6 design package §4–§11): a render assembles the chosen clip and
 * voice-over of every scene of the approved storyboard (gate 4) into one MP4 with captions and
 * optional music; a person approves it (gate 5) and exports the publishing package.
 */

export const renderBlockerSchema = z
  .object({
    code: z.enum([
      'STORYBOARD_NOT_APPROVED',
      'CLIPS_INCOMPLETE',
      'VOICEOVERS_INCOMPLETE',
      'VOICEOVER_EXCEEDS_SCENE',
      'INPUT_FILE_MISSING',
      'STORAGE_NOT_CONFIGURED',
    ]),
    message: z.string(),
    sceneNumber: z.number().int().nullable(),
  })
  .meta({ id: 'RenderBlocker' });

export const renderPlanSceneSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    durationSeconds: z.number(),
    text: z.string(),
    clip: assetSchema.nullable(),
    voiceover: assetSchema.nullable(),
    keyframe: assetSchema.nullable(),
  })
  .meta({ id: 'RenderPlanScene' });

export const renderPlanSchema = z
  .object({
    contentItemId: z.uuid(),
    storyboardVersionId: z.uuid().nullable(),
    scenes: z.array(renderPlanSceneSchema),
    totalSeconds: z.number(),
    /** Anything that prevents rendering; empty = ready. */
    blockers: z.array(renderBlockerSchema),
    /** Lowest clip resolution when clips will be scaled up to 1080×1920 (e.g. "720p"). */
    upscaledFrom: z.string().nullable(),
    /** Approved music uploads of the project (licence note required at upload). */
    musicOptions: z.array(assetSchema),
    /** A render job is queued or running for this item. */
    renderInProgress: z.boolean(),
  })
  .meta({ id: 'RenderPlan' });
export type RenderPlanDto = z.infer<typeof renderPlanSchema>;

export const createRenderRequestSchema = z
  .strictObject({
    captions: z.strictObject({ burnIn: z.boolean() }).optional(),
    music: z
      .strictObject({
        assetId: z.uuid(),
        /** Bed level under the voice (default −18 dB). */
        volumeDb: z.number().min(-40).max(0).optional(),
      })
      .optional(),
    /** Render even when an identical render already succeeded. */
    regenerate: z.boolean().optional(),
  })
  .meta({ id: 'CreateRenderRequest' });
export type CreateRenderRequest = z.output<typeof createRenderRequestSchema>;

export const renderStatusSchema = z
  .enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
  .meta({ id: 'RenderStatus' });

export const qcFindingSchema = z
  .object({
    check: z.string(),
    severity: z.enum(['error', 'warning']),
    message: z.string(),
    scene: z.number().int().nullable(),
  })
  .meta({ id: 'QcFinding' });

export const renderQcSchema = z
  .object({
    passed: z.boolean(),
    findings: z.array(qcFindingSchema),
    measured: z.object({
      width: z.number().nullable(),
      height: z.number().nullable(),
      fps: z.number().nullable(),
      durationMs: z.number().nullable(),
      videoCodec: z.string().nullable(),
      audioCodec: z.string().nullable(),
      integratedLufs: z.number().nullable(),
      truePeakDb: z.number().nullable(),
    }),
    ffmpeg: z.string().nullable(),
    elapsedMs: z.number().nullable(),
  })
  .meta({ id: 'RenderQc' });

export const renderSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    contentItemId: z.uuid(),
    storyboardVersionId: z.uuid(),
    status: renderStatusSchema,
    job: generationJobSchema,
    /** Last render stage reached while running (normalise, concat, narration, mix, loudness, encode). */
    stage: z.string().nullable(),
    burnInCaptions: z.boolean(),
    musicAssetId: z.uuid().nullable(),
    upscaledFrom: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    video: assetSchema.nullable(),
    subtitles: assetSchema.nullable(),
    thumbnail: assetSchema.nullable(),
    qc: renderQcSchema.nullable(),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']),
    reviewedAt: isoDateTimeSchema.nullable(),
    reviewNote: z.string().nullable(),
    /** This render is the content item's approved export (gate 5 pointer). */
    isApproved: z.boolean(),
    exportedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .meta({ id: 'Render' });
export type RenderDto = z.infer<typeof renderSchema>;

export const renderListSchema = z
  .object({ items: z.array(renderSchema) })
  .meta({ id: 'RenderList' });
export type RenderListDto = z.infer<typeof renderListSchema>;

export const createRenderResponseSchema = z
  .object({
    render: renderSchema,
    /** True when an identical earlier render was returned instead of rendering again. */
    reused: z.boolean(),
  })
  .meta({ id: 'CreateRenderResponse' });
export type CreateRenderResponseDto = z.infer<typeof createRenderResponseSchema>;

export const reviewRenderRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(2000).optional() })
  .meta({ id: 'ReviewRenderRequest' });
export type ReviewRenderRequest = z.output<typeof reviewRenderRequestSchema>;

export const rejectRenderRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(2000) })
  .meta({ id: 'RejectRenderRequest' });
export type RejectRenderRequest = z.output<typeof rejectRenderRequestSchema>;

const costCellSchema = z.object({
  calls: z.number().int(),
  reportedUsd: usdAmountSchema,
  estimatedUsd: usdAmountSchema,
  /** Calls whose cost is unknown: never counted as zero (CLAUDE.md §2.13). */
  unknownCalls: z.number().int(),
});

export const costReportSchema = z
  .object({
    contentItemId: z.uuid(),
    renderId: z.uuid(),
    currency: z.literal('USD'),
    /** Every AI call of the content item, including rejected candidates and retries. */
    total: costCellSchema,
    byStage: z.array(costCellSchema.extend({ stage: z.string() })),
    /** Calls that produced the assets this render used (keyframes, clips, voice-overs). */
    usedInRender: costCellSchema,
    /** Rendering itself runs locally with FFmpeg: no provider cost. */
    renderCostUsd: usdAmountSchema,
    generatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'CostReport' });
export type CostReportDto = z.infer<typeof costReportSchema>;

/** The package manifest: what was assembled, from which models and jobs, with checksums. */
export const renderManifestDocumentSchema = z
  .object({
    renderId: z.uuid(),
    contentItem: z.object({ id: z.uuid(), title: z.string(), language: z.string() }),
    script: z.unknown(),
    manifest: z.unknown(),
    settings: z.unknown(),
    qc: z.unknown(),
    outputs: z.array(
      z.object({
        role: z.enum(['video', 'subtitles', 'thumbnail']),
        assetId: z.uuid(),
        mimeType: z.string(),
        sizeBytes: z.number(),
        checksumSha256: z.string(),
      }),
    ),
    review: z.object({
      status: z.enum(['pending', 'approved', 'rejected']),
      reviewedAt: isoDateTimeSchema.nullable(),
      exportedAt: isoDateTimeSchema.nullable(),
    }),
  })
  .meta({ id: 'RenderManifestDocument' });
export type RenderManifestDocumentDto = z.infer<typeof renderManifestDocumentSchema>;

export const renderIdParamsSchema = z.strictObject({ renderId: z.uuid() });
