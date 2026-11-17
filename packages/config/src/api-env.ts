import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';
import {
  booleanStringSchema,
  logLevelSchema,
  nodeEnvSchema,
  portSchema,
  urlWithProtocol,
} from './schema-helpers.js';

/**
 * Environment contract for `apps/api`.
 *
 * Keep this list minimal: add variables only when a feature needs them.
 * Provider API keys are intentionally absent in M0 (no AI integrations yet).
 */
export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  API_HOST: z.string().trim().min(1).default('0.0.0.0'),
  API_PORT: portSchema.default(4000),
  /** Comma-separated list of browser origins allowed by CORS. */
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url({ message: 'each origin must be a valid URL' }))),
  LOG_LEVEL: logLevelSchema,
  /** Emit JSON log lines (recommended outside local development). */
  LOG_JSON: booleanStringSchema.default(false),
  DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:'], 'DATABASE_URL'),
  /** Maximum pooled PostgreSQL connections for this process. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * How long a query waits for a free pooled connection before failing. Independent of
   * HEALTH_CHECK_TIMEOUT_MS: requests that queue behind row locks must not fail at the
   * readiness-probe deadline.
   */
  DATABASE_POOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:'], 'REDIS_URL'),
  /** Per-dependency timeout for readiness checks only (not for application queries). */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  /** Reject mutations without `If-Match` with 428 (decision D9). Off until clients send it. */
  REQUIRE_IF_MATCH: booleanStringSchema.default(false),
  /** Serve `GET /openapi.json` without authentication. Defaults to true outside production. */
  OPENAPI_PUBLIC: booleanStringSchema.optional(),
});

/** The validated environment, with environment-dependent defaults resolved. */
const resolvedApiEnvSchema = apiEnvSchema.transform((env) => ({
  ...env,
  OPENAPI_PUBLIC: env.OPENAPI_PUBLIC ?? env.NODE_ENV !== 'production',
}));

export type ApiEnv = z.output<typeof resolvedApiEnvSchema>;

/**
 * Validates and normalizes API environment variables.
 * @throws {EnvValidationError} with variable names and problems (never values).
 */
export function loadApiEnv(source: Readonly<Record<string, string | undefined>>): ApiEnv {
  const result = resolvedApiEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError('API', toEnvIssues(result.error));
  }
  return result.data;
}
