import { z } from 'zod';

import { usdAmountSchema } from './ai.js';
import { isoDateTimeSchema } from './common.js';
import {
  generationJobKindSchema,
  generationJobStatusSchema,
  productionRunSchema,
} from './generation.js';

/**
 * Resume, operations summary and cost dashboard (M7 design package §6, §8, §9, §11).
 */

// ------------------------------------------------------------------- resume (§6)

export const resumeRunRequestSchema = z
  .strictObject({
    /**
     * Also resume jobs that ended with `SUBMIT_OUTCOME_UNKNOWN`: the provider may have accepted
     * (and will charge) the earlier submission (ADR-0017).
     */
    acceptPossibleDoubleCharge: z.boolean().optional(),
    /** Proceed although a soft budget would be exceeded (recorded as an override). */
    acceptOverBudget: z.boolean().optional(),
    acceptUnknownCost: z.boolean().optional(),
    /** Clips only: the estimate total the user confirmed (as for a normal clip request). */
    confirmedEstimateUsd: usdAmountSchema.optional(),
  })
  .meta({ id: 'ResumeRunRequest' });
export type ResumeRunRequest = z.output<typeof resumeRunRequestSchema>;

export const resumeSkipReasonSchema = z
  .enum([
    /** Ended with SUBMIT_OUTCOME_UNKNOWN; resend with acceptPossibleDoubleCharge. */
    'outcome_unknown',
    /** A later job of the same stage and scope succeeded. */
    'superseded',
    /** A later job of the same stage and scope is queued or running. */
    'in_progress',
    /**
     * P3d: the job's paid output was delivered; it is finished from that file in its own run
     * (no provider call, no cost, no confirmation).
     */
    'finished_without_charge',
  ])
  .meta({ id: 'ResumeSkipReason' });

export const resumeRunResponseSchema = z
  .object({
    resumedFromRunId: z.uuid(),
    /** The new run; null when every failed job was skipped by planning (nothing queued). */
    run: productionRunSchema.nullable(),
    skipped: z.array(
      z.object({
        jobId: z.uuid(),
        sceneId: z.uuid().nullable(),
        reason: resumeSkipReasonSchema,
      }),
    ),
  })
  .meta({ id: 'ResumeRunResponse' });
export type ResumeRunResponseDto = z.infer<typeof resumeRunResponseSchema>;

// ------------------------------------------------------------------- cost figures

/** Every figure keeps reported, estimated, unknown and held apart (B9). */
export const costFigureSchema = z
  .object({
    calls: z.number().int(),
    reportedUsd: usdAmountSchema,
    estimatedUsd: usdAmountSchema,
    unknownCalls: z.number().int(),
    /** Held reservations (outcome unknown) counted here until an owner resolves them. */
    heldUsd: usdAmountSchema,
    /** reported + estimated + held. */
    totalUsd: usdAmountSchema,
  })
  .meta({ id: 'CostFigure' });
export type CostFigureDto = z.infer<typeof costFigureSchema>;

// ------------------------------------------------------------------- operations summary (§8)

export const queueDepthSchema = z
  .object({
    queue: z.string(),
    waiting: z.number().int(),
    active: z.number().int(),
    delayed: z.number().int(),
    failed: z.number().int(),
  })
  .meta({ id: 'QueueDepth' });

export const heldReservationSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    projectName: z.string(),
    contentItemId: z.uuid(),
    contentTitle: z.string(),
    jobId: z.uuid(),
    jobKind: generationJobKindSchema,
    jobErrorCode: z.string().nullable(),
    amountUsd: usdAmountSchema,
    createdAt: isoDateTimeSchema,
    /** The caller owns the project and may settle or release it. */
    canResolve: z.boolean(),
  })
  .meta({ id: 'HeldReservation' });
export type HeldReservationDto = z.infer<typeof heldReservationSchema>;

export const opsSummarySchema = z
  .object({
    generatedAt: isoDateTimeSchema,
    /** null when Redis is unreachable (the rest still comes from PostgreSQL). */
    queues: z.array(queueDepthSchema).nullable(),
    /** Jobs of the caller's projects updated in the last 24 h, by kind and status. */
    jobs24h: z.array(
      z.object({
        kind: generationJobKindSchema,
        status: generationJobStatusSchema,
        count: z.number().int(),
      }),
    ),
    /** Finally failed jobs (each also has a dead-letter copy), newest first, at most 50. */
    failedJobs: z.array(
      z.object({
        jobId: z.uuid(),
        kind: generationJobKindSchema,
        errorCode: z.string().nullable(),
        errorMessage: z.string().nullable(),
        attempt: z.number().int(),
        projectId: z.uuid(),
        projectName: z.string(),
        contentItemId: z.uuid(),
        contentTitle: z.string(),
        productionRunId: z.uuid(),
        failedAt: isoDateTimeSchema,
      }),
    ),
    circuits: z.array(
      z.object({
        providerKey: z.string(),
        providerName: z.string(),
        state: z.enum(['closed', 'open', 'half_open']),
        consecutiveFailures: z.number().int(),
        retryAt: isoDateTimeSchema.nullable(),
        lastErrorCode: z.string().nullable(),
      }),
    ),
    /** This UTC month per project of the caller. */
    budgets: z.array(
      z.object({
        projectId: z.uuid(),
        projectName: z.string(),
        limitUsd: usdAmountSchema,
        usedUsd: usdAmountSchema,
        heldUsd: usdAmountSchema,
        warning: z.boolean(),
      }),
    ),
    heldReservations: z.array(heldReservationSchema),
  })
  .meta({ id: 'OpsSummary' });
export type OpsSummaryDto = z.infer<typeof opsSummarySchema>;

export const reservationIdParamsSchema = z.strictObject({ reservationId: z.uuid() });

export const resolveReservationRequestSchema = z
  .strictObject({ note: z.string().trim().min(1).max(500).optional() })
  .meta({ id: 'ResolveReservationRequest' });
export type ResolveReservationRequest = z.output<typeof resolveReservationRequestSchema>;

// ------------------------------------------------------------------- cost dashboard (§9)

export const costMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .meta({ id: 'CostMonth', description: 'UTC calendar month, YYYY-MM.' });

export const projectCostsQuerySchema = z.strictObject({ month: costMonthSchema.optional() });

export const projectCostsSchema = z
  .object({
    projectId: z.uuid(),
    month: costMonthSchema,
    total: costFigureSchema,
    /** The monthly limit (and whether the month's total reached the warning share). */
    budget: z.object({ limitUsd: usdAmountSchema, warning: z.boolean() }),
    byContentItem: z.array(
      z.object({ contentItemId: z.uuid(), title: z.string(), cost: costFigureSchema }),
    ),
    byStage: z.array(z.object({ kind: generationJobKindSchema, cost: costFigureSchema })),
    byModel: z.array(
      z.object({ providerKey: z.string(), modelKey: z.string(), cost: costFigureSchema }),
    ),
    /** Charged calls of attempts that did not produce the job's result. */
    retryCost: costFigureSchema,
    /** Total of content items with an approved render, per approved video. Null when none. */
    costPerApprovedVideo: z
      .object({ approvedVideos: z.number().int(), perVideoUsd: usdAmountSchema })
      .nullable(),
    /** The six months ending with `month`, oldest first. */
    trend: z.array(z.object({ month: costMonthSchema, cost: costFigureSchema })),
  })
  .meta({ id: 'ProjectCosts' });
export type ProjectCostsDto = z.infer<typeof projectCostsSchema>;
