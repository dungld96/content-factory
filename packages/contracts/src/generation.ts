import { z } from 'zod';

import { scriptContentSchema, storyboardSceneSchema } from '@acf/content-domain/schemas';

import { isoDateTimeSchema } from './common.js';
import { usdAmountSchema } from './ai.js';
import { paginationQuerySchema } from './pagination.js';

/** Script/storyboard pipeline contracts (M3 design package §10). */

export const ruleIssueSchema = z
  .object({ path: z.string(), message: z.string() })
  .meta({ id: 'RuleIssue' });

export const briefValidationSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(ruleIssueSchema),
    warnings: z.array(ruleIssueSchema),
    /** Claim-like terms found; the script must list claims requiring verification. */
    flags: z.array(z.string()),
  })
  .meta({ id: 'BriefValidation' });
export type BriefValidationDto = z.infer<typeof briefValidationSchema>;

export const generationJobKindSchema = z
  .enum([
    'script_generation',
    'storyboard_generation',
    'image_generation',
    'video_generation',
    'tts_generation',
    'render',
  ])
  .meta({ id: 'GenerationJobKind' });
export const generationJobStatusSchema = z
  .enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
  .meta({ id: 'GenerationJobStatus' });
export const artifactStatusSchema = z
  .enum(['pending_review', 'approved', 'rejected'])
  .meta({ id: 'ArtifactStatus' });

export const generateRequestSchema = z
  .strictObject({
    /** Override the task route with another enabled model (editor). */
    modelKey: z.string().min(1).max(200).optional(),
    /** Generate even when identical inputs already produced a result (costs again). */
    regenerate: z.boolean().optional(),
    /** M7: proceed although a soft budget would be exceeded (recorded as an override). */
    acceptOverBudget: z.boolean().optional(),
  })
  .meta({ id: 'GenerateRequest' });
export type GenerateRequest = z.output<typeof generateRequestSchema>;

/** Cost of a job's LLM calls, from the ledger (ADR-0012): never an amount for unknown cost. */
export const jobCostSchema = z
  .object({
    calls: z.number().int(),
    /** Sum of provider-reported costs. */
    reportedUsd: usdAmountSchema,
    /** Sum of estimates for calls without a reported cost. */
    estimatedUsd: usdAmountSchema,
    /** Calls whose cost is unknown (no report, no complete price). */
    unknownCalls: z.number().int(),
  })
  .meta({ id: 'JobCost' });
export type JobCostDto = z.infer<typeof jobCostSchema>;

export const jobEventSchema = z
  .object({
    fromStatus: generationJobStatusSchema.nullable(),
    toStatus: generationJobStatusSchema,
    attempt: z.number().int(),
    type: z.string(),
    errorCode: z.string().nullable(),
    createdAt: isoDateTimeSchema,
  })
  .meta({ id: 'JobEvent' });

export const generationJobSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    contentItemId: z.uuid(),
    productionRunId: z.uuid(),
    kind: generationJobKindSchema,
    /** The storyboard scene of a scene media job (images, clips, voice-overs); null otherwise. */
    storyboardSceneId: z.uuid().nullable(),
    status: generationJobStatusSchema,
    attempt: z.number().int(),
    maxAttempts: z.number().int(),
    modelKey: z.string(),
    promptTemplateId: z.string(),
    resultScriptVersionId: z.uuid().nullable(),
    resultStoryboardVersionId: z.uuid().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    cost: jobCostSchema,
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'GenerationJob' });
export type GenerationJobDto = z.infer<typeof generationJobSchema>;

export const generationJobDetailSchema = generationJobSchema
  .extend({ events: z.array(jobEventSchema) })
  .meta({ id: 'GenerationJobDetail' });
export type GenerationJobDetailDto = z.infer<typeof generationJobDetailSchema>;

export const generateResponseSchema = z
  .object({
    productionRunId: z.uuid(),
    job: generationJobSchema,
    /** True when an identical earlier result was reused: no new job, no new cost. */
    reused: z.boolean(),
  })
  .meta({ id: 'GenerateResponse' });
export type GenerateResponseDto = z.infer<typeof generateResponseSchema>;

export const productionRunSchema = z
  .object({
    id: z.uuid(),
    contentItemId: z.uuid(),
    status: generationJobStatusSchema,
    jobs: z.array(generationJobSchema),
    cost: jobCostSchema,
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
    /** The run this one resumed (M7c), if any. */
    resumedFromRunId: z.uuid().nullable(),
  })
  .meta({ id: 'ProductionRun' });
export type ProductionRunDto = z.infer<typeof productionRunSchema>;

const reviewFields = {
  status: artifactStatusSchema,
  source: z.enum(['generated', 'edited']),
  basedOnVersionId: z.uuid().nullable(),
  generationJobId: z.uuid().nullable(),
  createdById: z.uuid().nullable(),
  reviewedById: z.uuid().nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  reviewNote: z.string().nullable(),
  createdAt: isoDateTimeSchema,
};

export const scriptVersionSchema = z
  .object({
    id: z.uuid(),
    contentItemId: z.uuid(),
    version: z.number().int(),
    ...reviewFields,
    /** The content item's approved script (gate 1). */
    isApproved: z.boolean(),
    schemaVersion: z.number().int(),
    content: scriptContentSchema,
  })
  .meta({ id: 'ScriptVersion' });
export type ScriptVersionDto = z.infer<typeof scriptVersionSchema>;

export const editScriptRequestSchema = z
  .strictObject({ content: scriptContentSchema })
  .meta({ id: 'EditScriptRequest' });
export type EditScriptRequest = z.output<typeof editScriptRequestSchema>;

export const reviewRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(2000).optional() })
  .meta({ id: 'ReviewRequest' });
export type ReviewRequest = z.output<typeof reviewRequestSchema>;

export const storyboardSceneDtoSchema = storyboardSceneSchema
  .extend({ id: z.uuid() })
  .meta({ id: 'StoryboardScene' });
export type StoryboardSceneDto = z.infer<typeof storyboardSceneDtoSchema>;

export const storyboardVersionSchema = z
  .object({
    id: z.uuid(),
    contentItemId: z.uuid(),
    scriptVersionId: z.uuid(),
    version: z.number().int(),
    ...reviewFields,
    totalDurationSeconds: z.number(),
    /** Its script is no longer the approved script: it cannot be approved (ADR-0005). */
    stale: z.boolean(),
    isApproved: z.boolean(),
    schemaVersion: z.number().int(),
  })
  .meta({ id: 'StoryboardVersion' });
export type StoryboardVersionDto = z.infer<typeof storyboardVersionSchema>;

export const storyboardVersionDetailSchema = storyboardVersionSchema
  .extend({ scenes: z.array(storyboardSceneDtoSchema) })
  .meta({ id: 'StoryboardVersionDetail' });
export type StoryboardVersionDetailDto = z.infer<typeof storyboardVersionDetailSchema>;

/** Changes to one scene; the edit creates a new storyboard version (M3 Q2). */
export const editSceneRequestSchema = storyboardSceneSchema
  .omit({ sceneNumber: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'EditSceneRequest' });
export type EditSceneRequest = z.output<typeof editSceneRequestSchema>;

export const scriptVersionIdParamsSchema = z.strictObject({ scriptVersionId: z.uuid() });
export const storyboardVersionIdParamsSchema = z.strictObject({ storyboardVersionId: z.uuid() });
export const sceneIdParamsSchema = z.strictObject({ sceneId: z.uuid() });
export const runIdParamsSchema = z.strictObject({ runId: z.uuid() });
export const jobIdParamsSchema = z.strictObject({ jobId: z.uuid() });
export const listArtifactVersionsQuerySchema = paginationQuerySchema;

/** `GET /content/:contentId/jobs` (P3 W4): the item's jobs, newest first. */
export const listContentJobsQuerySchema = paginationQuerySchema.extend({
  kind: generationJobKindSchema.optional(),
  status: generationJobStatusSchema.optional(),
});
export type ListContentJobsQuery = z.output<typeof listContentJobsQuerySchema>;
