import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { generationJobKindSchema, generationJobStatusSchema } from './generation.js';

/**
 * Live job tracking (redesign R-D5, package §5): small deltas of job state transitions, read
 * from `job_events` after commit. The cursor is opaque to clients (`<createdAt ms>-<event id>`).
 */
export const liveCursorSchema = z
  .string()
  .regex(/^\d{13}-[0-9a-f-]{36}$/)
  .meta({ id: 'LiveCursor' });

export const liveJobEventSchema = z
  .object({
    /** The cursor of this event: resume after it. */
    id: z.string(),
    jobId: z.uuid(),
    projectId: z.uuid(),
    contentItemId: z.uuid(),
    contentTitle: z.string(),
    productionRunId: z.uuid(),
    kind: generationJobKindSchema,
    sceneNumber: z.number().int().nullable(),
    from: generationJobStatusSchema.nullable(),
    to: generationJobStatusSchema,
    attempt: z.number().int(),
    at: isoDateTimeSchema,
  })
  .meta({ id: 'LiveJobEvent' });
export type LiveJobEventDto = z.infer<typeof liveJobEventSchema>;

export const activeJobSchema = z
  .object({
    jobId: z.uuid(),
    projectId: z.uuid(),
    contentItemId: z.uuid(),
    contentTitle: z.string(),
    kind: generationJobKindSchema,
    sceneNumber: z.number().int().nullable(),
    status: z.enum(['queued', 'running']),
    attempt: z.number().int(),
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'ActiveJob' });
export type ActiveJobDto = z.infer<typeof activeJobSchema>;

/** `GET /jobs/active`: the caller's queued and running jobs and the cursor to follow from. */
export const activeJobsSchema = z
  .object({ cursor: z.string(), jobs: z.array(activeJobSchema) })
  .meta({ id: 'ActiveJobs' });
export type ActiveJobsDto = z.infer<typeof activeJobsSchema>;

export const jobChangesQuerySchema = z.strictObject({ since: liveCursorSchema });

/**
 * `GET /jobs/changes?since=`: the polling fallback of `GET /events`. `resync` means the gap was
 * too large: reload `GET /jobs/active` and the page's data.
 */
export const jobChangesSchema = z
  .object({ cursor: z.string(), events: z.array(liveJobEventSchema), resync: z.boolean() })
  .meta({ id: 'JobChanges' });
export type JobChangesDto = z.infer<typeof jobChangesSchema>;
