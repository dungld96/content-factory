import { z } from 'zod';

import { usdAmountSchema } from './ai.js';
import { assetSchema } from './assets.js';
import { generationJobSchema } from './generation.js';

/**
 * Image generation for storyboard scenes (M4 design package §5–§7). One job per scene; the
 * candidates are `generated` image assets; each scene's keyframe is an approved candidate.
 */

export const imageResolutionSchema = z.enum(['1K', '1.5K', '2K']).meta({ id: 'ImageResolution' });

export const imageGenerationRequestSchema = z
  .strictObject({
    /** Scenes to generate; default: every scene without a keyframe. */
    sceneIds: z.array(z.uuid()).min(1).max(50).optional(),
    /** Candidates per scene (default 1, at most 4; decision G5). */
    count: z.number().int().min(1).max(4).optional(),
    /** Default 2K when the model supports it. */
    resolution: imageResolutionSchema.optional(),
    /** Override the image task route with another enabled model (editor). */
    modelKey: z.string().min(1).max(200).optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
    /** Generate even when identical inputs already produced candidates (costs again). */
    regenerate: z.boolean().optional(),
    /** M7: proceed although a soft budget would be exceeded (recorded as an override). */
    acceptOverBudget: z.boolean().optional(),
    /** Required to generate when the cost cannot be estimated (COST_STRATEGY §3). */
    acceptUnknownCost: z.boolean().optional(),
  })
  .meta({ id: 'ImageGenerationRequest' });
export type ImageGenerationRequest = z.output<typeof imageGenerationRequestSchema>;

export const sceneImagePlanSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    /**
     * `generate`: a job will be created. `reuse_keyframe`: an identical scene of an earlier
     * storyboard version already has a keyframe, which is reused. `skip_*`: nothing to do.
     */
    action: z.enum([
      'generate',
      'reuse_keyframe',
      'skip_has_keyframe',
      'skip_existing_result',
      'skip_in_progress',
    ]),
    references: z.number().int(),
    /** Null when the model's price per image is unknown (e.g. priced by token). */
    estimatedUsd: usdAmountSchema.nullable(),
  })
  .meta({ id: 'SceneImagePlan' });

export const imageEstimateSchema = z
  .object({
    modelKey: z.string(),
    resolution: imageResolutionSchema.nullable(),
    count: z.number().int(),
    scenes: z.array(sceneImagePlanSchema),
    /** Sum over scenes to generate; null when any of them is unknown. Never 0 for unknown. */
    totalEstimatedUsd: usdAmountSchema.nullable(),
    unknownCost: z.boolean(),
  })
  .meta({ id: 'ImageEstimate' });
export type ImageEstimateDto = z.infer<typeof imageEstimateSchema>;

export const imageGenerateResponseSchema = z
  .object({
    /** Null when every scene was reused or skipped (no new work). */
    productionRunId: z.uuid().nullable(),
    jobs: z.array(generationJobSchema),
    estimate: imageEstimateSchema,
  })
  .meta({ id: 'ImageGenerateResponse' });
export type ImageGenerateResponseDto = z.infer<typeof imageGenerateResponseSchema>;

export const sceneImagesSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    imagePrompt: z.string(),
    keyframe: assetSchema.nullable(),
    /** Images generated for this scene or for an identical scene of an earlier version. */
    candidates: z.array(assetSchema),
    activeJob: generationJobSchema.nullable(),
    lastJob: generationJobSchema.nullable(),
  })
  .meta({ id: 'SceneImages' });

export const storyboardImagesSchema = z
  .object({
    storyboardVersionId: z.uuid(),
    /** Whether this is the content item's approved storyboard (gate 2). */
    approved: z.boolean(),
    /** Gate 3: every scene has a keyframe. */
    keyframesComplete: z.boolean(),
    scenes: z.array(sceneImagesSchema),
  })
  .meta({ id: 'StoryboardImages' });
export type StoryboardImagesDto = z.infer<typeof storyboardImagesSchema>;

export const setKeyframeRequestSchema = z
  .strictObject({ assetId: z.uuid() })
  .meta({ id: 'SetKeyframeRequest' });
export type SetKeyframeRequest = z.output<typeof setKeyframeRequestSchema>;
