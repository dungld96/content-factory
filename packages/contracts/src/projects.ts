import { z } from 'zod';

import { projectRoleSchema } from './auth.js';
import {
  includeArchivedSchema,
  isoDateTimeSchema,
  languageTagSchema,
  optionalTextSchema,
  slugSchema,
  timeZoneSchema,
} from './common.js';

export const projectIdParamsSchema = z.strictObject({ projectId: z.uuid() });

export const createProjectRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    /** Globally unique (decision D12). */
    slug: slugSchema,
    description: optionalTextSchema(5000).optional(),
    defaultLanguage: languageTagSchema,
    timezone: timeZoneSchema,
  })
  .meta({ id: 'CreateProjectRequest' });
export type CreateProjectRequest = z.output<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = createProjectRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' })
  .meta({ id: 'UpdateProjectRequest' });
export type UpdateProjectRequest = z.output<typeof updateProjectRequestSchema>;

export const projectSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    defaultLanguage: z.string(),
    timezone: z.string(),
    /** The caller's role in this project. */
    role: projectRoleSchema,
    archivedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Project' });
export type ProjectDto = z.infer<typeof projectSchema>;

export const listProjectsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: includeArchivedSchema,
});

// --- members ---------------------------------------------------------------------

export const memberParamsSchema = z.strictObject({ projectId: z.uuid(), userId: z.uuid() });

export const addMemberRequestSchema = z
  .strictObject({
    email: z.string().trim().min(3).max(320),
    role: projectRoleSchema,
  })
  .meta({ id: 'AddMemberRequest' });
export type AddMemberRequest = z.output<typeof addMemberRequestSchema>;

export const updateMemberRequestSchema = z
  .strictObject({ role: projectRoleSchema })
  .meta({ id: 'UpdateMemberRequest' });
export type UpdateMemberRequest = z.output<typeof updateMemberRequestSchema>;

export const memberSchema = z
  .object({
    projectId: z.uuid(),
    userId: z.uuid(),
    email: z.string(),
    displayName: z.string(),
    role: projectRoleSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'Member' });
export type MemberDto = z.infer<typeof memberSchema>;
