import { z } from 'zod';

import { usdAmountSchema } from './ai.js';
import { assetSchema } from './assets.js';
import { includeArchivedSchema, isoDateTimeSchema } from './common.js';
import { generationJobSchema } from './generation.js';

/**
 * Scene clips, voice-overs and voice profiles (M5 design package §6–§7, §11). One job per scene;
 * candidates are `generated` video/audio assets; each scene's clip and voice-over is an approved
 * candidate selected by the user (gate 4).
 */

export const videoResolutionSchema = z
  .enum(['480p', '720p', '1080p'])
  .meta({ id: 'VideoResolution' });

export const videoGenerationRequestSchema = z
  .strictObject({
    /** Scenes to generate; default: every scene with a keyframe and no clip. */
    sceneIds: z.array(z.uuid()).min(1).max(50).optional(),
    /** Default 720p (decision V4). */
    resolution: videoResolutionSchema.optional(),
    /** Native audio track, when the model offers it (default false: the voice-over is separate). */
    generateAudio: z.boolean().optional(),
    /** Override the video task route with another enabled model (editor). */
    modelKey: z.string().min(1).max(200).optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
    /** Generate even when identical inputs already produced a clip (costs again). */
    regenerate: z.boolean().optional(),
    /** Required to generate when the cost cannot be estimated (COST_STRATEGY §3). */
    acceptUnknownCost: z.boolean().optional(),
    /**
     * Generate only: the total the user was shown (decision V10). The request is refused when
     * the current estimate is higher. Null confirms an unknown estimate.
     */
    confirmedEstimateUsd: usdAmountSchema.nullable().optional(),
  })
  .meta({ id: 'VideoGenerationRequest' });
export type VideoGenerationRequest = z.output<typeof videoGenerationRequestSchema>;

export const sceneVideoPlanSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    /**
     * `generate`: a job will be created. `reuse_clip`: an identical scene with the same keyframe
     * already has a selected clip, which is reused. `skip_*`: nothing to do.
     */
    action: z.enum([
      'generate',
      'reuse_clip',
      'skip_has_clip',
      'skip_existing_result',
      'skip_in_progress',
      'skip_no_keyframe',
      'skip_exceeds_model_maximum',
    ]),
    sceneSeconds: z.number(),
    /** Clip length requested: a supported duration ≥ the scene; null when none fits. */
    requestedSeconds: z.number().int().nullable(),
    /** Seconds billed: the requested length, or the model's minimum billed seconds if higher. */
    billedSeconds: z.number().int().nullable(),
    /** Null when the price is unknown. */
    estimatedUsd: usdAmountSchema.nullable(),
  })
  .meta({ id: 'SceneVideoPlan' });

export const videoEstimateSchema = z
  .object({
    modelKey: z.string(),
    resolution: videoResolutionSchema,
    generateAudio: z.boolean(),
    scenes: z.array(sceneVideoPlanSchema),
    /** Sum over scenes to generate; null when any is unknown. Never 0 for unknown. */
    totalEstimatedUsd: usdAmountSchema.nullable(),
    unknownCost: z.boolean(),
    /** Largest estimate one request may queue until M7 budgets (`SPEND_GUARD`). */
    spendGuardUsd: usdAmountSchema,
    /** The provider keeps prompts and keyframes (no zero-data-retention for video; risk R1). */
    providerRetainsInputs: z.boolean(),
  })
  .meta({ id: 'VideoEstimate' });
export type VideoEstimateDto = z.infer<typeof videoEstimateSchema>;

export const videoGenerateResponseSchema = z
  .object({
    productionRunId: z.uuid().nullable(),
    jobs: z.array(generationJobSchema),
    estimate: videoEstimateSchema,
  })
  .meta({ id: 'VideoGenerateResponse' });
export type VideoGenerateResponseDto = z.infer<typeof videoGenerateResponseSchema>;

export const providerProgressSchema = z
  .object({
    /** Provider job status (`pending`, `in_progress`, …); null before the submit is confirmed. */
    providerStatus: z.string().nullable(),
    pollCount: z.number().int(),
    submittedAt: isoDateTimeSchema.nullable(),
    lastPolledAt: isoDateTimeSchema.nullable(),
    nextPollAt: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'ProviderProgress' });

export const sceneVideosSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    durationSeconds: z.number(),
    videoPrompt: z.string(),
    keyframe: assetSchema.nullable(),
    clip: assetSchema.nullable(),
    /** Clips generated for this scene or for an identical scene with the same keyframe. */
    candidates: z.array(assetSchema),
    activeJob: generationJobSchema.nullable(),
    lastJob: generationJobSchema.nullable(),
    /** Progress of the active (or last) video job at the provider. */
    progress: providerProgressSchema.nullable(),
  })
  .meta({ id: 'SceneVideos' });

export const storyboardVideosSchema = z
  .object({
    storyboardVersionId: z.uuid(),
    approved: z.boolean(),
    keyframesComplete: z.boolean(),
    /** Gate 4 (clips): every scene has a selected clip. */
    clipsComplete: z.boolean(),
    scenes: z.array(sceneVideosSchema),
  })
  .meta({ id: 'StoryboardVideos' });
export type StoryboardVideosDto = z.infer<typeof storyboardVideosSchema>;

export const selectSceneMediaRequestSchema = z
  .strictObject({ assetId: z.uuid() })
  .meta({ id: 'SelectSceneMediaRequest' });
export type SelectSceneMediaRequest = z.output<typeof selectSceneMediaRequestSchema>;

// ------------------------------------------------------------------- voice-overs

export const voiceoverGenerationRequestSchema = z
  .strictObject({
    /** Scenes to generate; default: every scene with voice-over text and no voice-over. */
    sceneIds: z.array(z.uuid()).min(1).max(50).optional(),
    regenerate: z.boolean().optional(),
    acceptUnknownCost: z.boolean().optional(),
  })
  .meta({ id: 'VoiceoverGenerationRequest' });
export type VoiceoverGenerationRequest = z.output<typeof voiceoverGenerationRequestSchema>;

export const sceneVoiceoverPlanSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    action: z.enum([
      'generate',
      'reuse_voiceover',
      'skip_has_voiceover',
      'skip_existing_result',
      'skip_in_progress',
      'skip_no_text',
    ]),
    characters: z.number().int(),
    estimatedUsd: usdAmountSchema.nullable(),
  })
  .meta({ id: 'SceneVoiceoverPlan' });

export const voiceoverEstimateSchema = z
  .object({
    modelKey: z.string(),
    voiceProfileId: z.uuid(),
    scenes: z.array(sceneVoiceoverPlanSchema),
    totalEstimatedUsd: usdAmountSchema.nullable(),
    unknownCost: z.boolean(),
  })
  .meta({ id: 'VoiceoverEstimate' });
export type VoiceoverEstimateDto = z.infer<typeof voiceoverEstimateSchema>;

export const voiceoverGenerateResponseSchema = z
  .object({
    productionRunId: z.uuid().nullable(),
    jobs: z.array(generationJobSchema),
    estimate: voiceoverEstimateSchema,
  })
  .meta({ id: 'VoiceoverGenerateResponse' });
export type VoiceoverGenerateResponseDto = z.infer<typeof voiceoverGenerateResponseSchema>;

export const sceneVoiceoversSchema = z
  .object({
    sceneId: z.uuid(),
    sceneNumber: z.number().int(),
    durationSeconds: z.number(),
    text: z.string(),
    voiceover: assetSchema.nullable(),
    /** Generated for this scene's text and voice, plus imported voice-over uploads. */
    candidates: z.array(assetSchema),
    /** The selected voice-over is longer than the scene (M6 does not stretch it). */
    exceedsScene: z.boolean(),
    activeJob: generationJobSchema.nullable(),
    lastJob: generationJobSchema.nullable(),
  })
  .meta({ id: 'SceneVoiceovers' });

export const storyboardVoiceoversSchema = z
  .object({
    storyboardVersionId: z.uuid(),
    approved: z.boolean(),
    voiceProfileId: z.uuid().nullable(),
    /** Gate 4 (voice-over): every scene with text has a selected voice-over. */
    voiceoversComplete: z.boolean(),
    scenes: z.array(sceneVoiceoversSchema),
  })
  .meta({ id: 'StoryboardVoiceovers' });
export type StoryboardVoiceoversDto = z.infer<typeof storyboardVoiceoversSchema>;

// ------------------------------------------------------------------- voice profiles

const speedSchema = z.number().min(0.5).max(2).multipleOf(0.01);

export const voiceProfileSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    name: z.string(),
    modelKey: z.string(),
    voice: z.string(),
    language: z.string(),
    speed: z.number().nullable(),
    instructions: z.string().nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'VoiceProfile' });
export type VoiceProfileDto = z.infer<typeof voiceProfileSchema>;

export const voiceProfileListSchema = z
  .object({ items: z.array(voiceProfileSchema) })
  .meta({ id: 'VoiceProfileList' });
export type VoiceProfileListDto = z.infer<typeof voiceProfileListSchema>;

export const createVoiceProfileRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    /** A TTS model of the registry (e.g. `mock/tone-tts`). */
    modelKey: z.string().min(1).max(200),
    /** The provider voice id; checked against the model's voices when the catalog lists them. */
    voice: z.string().trim().min(1).max(200),
    language: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/)
      .max(35),
    speed: speedSchema.nullable().optional(),
    instructions: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .meta({ id: 'CreateVoiceProfileRequest' });
export type CreateVoiceProfileRequest = z.output<typeof createVoiceProfileRequestSchema>;

export const updateVoiceProfileRequestSchema = createVoiceProfileRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateVoiceProfileRequest' });
export type UpdateVoiceProfileRequest = z.output<typeof updateVoiceProfileRequestSchema>;

export const listVoiceProfilesQuerySchema = z.strictObject({
  includeArchived: includeArchivedSchema,
});

export const voiceProfileIdParamsSchema = z.strictObject({ voiceProfileId: z.uuid() });
