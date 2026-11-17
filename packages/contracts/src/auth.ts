import { z } from 'zod';

/** `POST /auth/login`. Emails are normalized (trimmed, lower-cased) by the server. */
export const loginRequestSchema = z
  .strictObject({
    email: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(1024),
  })
  .meta({ id: 'LoginRequest' });
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authUserSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
  })
  .meta({ id: 'AuthUser' });
export type AuthUser = z.infer<typeof authUserSchema>;

export const projectRoleSchema = z.enum(['owner', 'editor', 'viewer']).meta({ id: 'ProjectRole' });
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const loginResponseSchema = z
  .object({
    user: authUserSchema,
    /** Send as `x-csrf-token` on every state-changing request. Keep it in memory only. */
    csrfToken: z.string(),
  })
  .meta({ id: 'LoginResponse' });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const membershipSchema = z
  .object({
    projectId: z.uuid(),
    projectSlug: z.string(),
    projectName: z.string(),
    role: projectRoleSchema,
  })
  .meta({ id: 'Membership' });
export type Membership = z.infer<typeof membershipSchema>;

/** `GET /auth/me`. */
export const meResponseSchema = z
  .object({ user: authUserSchema, memberships: z.array(membershipSchema) })
  .meta({ id: 'MeResponse' });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `GET /auth/csrf`. */
export const csrfResponseSchema = z.object({ csrfToken: z.string() }).meta({ id: 'CsrfResponse' });
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;

/** Header carrying the CSRF token on state-changing requests. */
export const CSRF_HEADER = 'x-csrf-token';
