import { z } from 'zod';

export const HealthStatus = {
  Ok: 'ok',
  Error: 'error',
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export const healthStatusSchema = z.enum([HealthStatus.Ok, HealthStatus.Error]);

export const dependencyCheckSchema = z.object({
  status: healthStatusSchema,
  latencyMs: z.number().int().nonnegative(),
  /** Sanitized, user-safe failure reason. Never contains credentials or hostnames with auth. */
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/** `GET /api/v1/health` — liveness: process is up. Does not touch dependencies. */
export const livenessResponseSchema = z.object({
  status: z.literal(HealthStatus.Ok),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

/** `GET /api/v1/health/ready` — readiness: required dependencies reachable. 503 when not ok. */
export const readinessResponseSchema = z.object({
  status: healthStatusSchema,
  timestamp: z.iso.datetime(),
  checks: z.object({
    database: dependencyCheckSchema,
    redis: dependencyCheckSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ReadinessCheckName = keyof ReadinessResponse['checks'];
