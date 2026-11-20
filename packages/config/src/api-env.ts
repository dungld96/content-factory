import { z } from 'zod';

import { aiProviderEnvShape, checkAiProviderEnv } from './ai-provider-env.js';
import { mediaEnvShape } from './media-env.js';
import { checkStorageEnv, storageEnvShape } from './storage-env.js';
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
 * Provider API keys are server-only: never logged, never sent to the web app (M2 design §8.3).
 */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/** Express `trust proxy` value: a hop count, `true` (trust all), or an address/preset list. */
export type TrustProxy = number | boolean | string[];

function parseTrustProxy(value: string): TrustProxy {
  if (value === 'true' || value === '*') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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

  // --- Authentication (ADR-0009, design package §5.4) ---
  /**
   * Session-cookie signing secrets, comma-separated: the first signs, all verify (rotation).
   * Each at least 32 characters.
   */
  SESSION_SECRETS: commaList.pipe(
    z.array(z.string().min(32, 'each secret must be at least 32 characters')).min(1),
  ),
  /** Secret for CSRF token HMACs; at least 32 characters and distinct from the session secrets. */
  CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** `Secure` cookies with the `__Host-` prefix. Defaults to true in production (required there). */
  SESSION_COOKIE_SECURE: booleanStringSchema.optional(),
  /** Idle session lifetime, rolling (decision D5: 24 h). */
  SESSION_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  /** Absolute session lifetime, never extended (decision D5: 7 days). */
  SESSION_ABSOLUTE_TTL_MS: z.coerce.number().int().min(60_000).default(604_800_000),
  /**
   * Express `trust proxy`: which hops may set `X-Forwarded-*`. Name the Next.js hop
   * (e.g. `loopback`, an IP/CIDR list, or a hop count). `true`/`*` is rejected in production.
   */
  TRUST_PROXY: z.string().trim().min(1).default('loopback'),
  /** Browser origins allowed to send state-changing requests (Origin check, design §5.7). */
  WEB_ORIGINS: commaList
    .pipe(z.array(z.url({ message: 'each origin must be a valid URL' })).min(1))
    .default(['http://localhost:3000']),
  /**
   * Platform operators (P1 design O1): the users who may change AI providers, models and routes
   * over HTTP. Comma-separated emails, compared case-insensitively. Empty: nobody (CLI only).
   */
  OPERATOR_EMAILS: commaList
    .pipe(z.array(z.email({ message: 'each operator must be an email address' })))
    .transform((emails) => emails.map((e) => e.toLowerCase()))
    .default([]),
  /** Login attempts allowed per client IP per minute. */
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),

  /** BullMQ key prefix shared with the worker (M3); tests isolate themselves with their own. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9:_-]{1,32}$/)
    .default('acf'),
  // --- AI providers (M2 design package §8.3), shared with the worker ---
  ...aiProviderEnvShape,
  // --- Object storage (M4a, ADR-0006), shared with the worker ---
  ...storageEnvShape,
  /** Largest accepted image upload, in bytes (M4 design §4.2: 25 MB). */
  UPLOAD_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  // --- Media tools (M5a), shared with the worker ---
  ...mediaEnvShape,
  /** Largest accepted audio upload, in bytes (M5 design §7.3: 25 MB). */
  UPLOAD_MAX_AUDIO_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(25 * 1024 * 1024),
  // --- Budgets (M7 design §3.2): defaults of a project's budget, created on first use ---
  /** Monthly limit (UTC calendar month), hard. */
  DEFAULT_MONTHLY_BUDGET_USD: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .default('10'),
  /** Per content item (all time), soft (needs confirmation). */
  DEFAULT_ITEM_BUDGET_USD: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .default('3'),
  /** Per request (replaces the M5 video-only spend guard), hard. */
  DEFAULT_REQUEST_BUDGET_USD: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,6})?$/)
    .default('2'),
});

/** The validated environment, with environment-dependent defaults resolved. */
const resolvedApiEnvSchema = apiEnvSchema
  .transform((env) => {
    const production = env.NODE_ENV === 'production';
    return {
      ...env,
      OPENAPI_PUBLIC: env.OPENAPI_PUBLIC ?? !production,
      SESSION_COOKIE_SECURE: env.SESSION_COOKIE_SECURE ?? production,
      TRUST_PROXY: parseTrustProxy(env.TRUST_PROXY),
    };
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_SECRETS.includes(env.CSRF_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CSRF_SECRET'],
        message: 'must differ from every SESSION_SECRETS entry',
      });
    }
    if (env.SESSION_ABSOLUTE_TTL_MS < env.SESSION_IDLE_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_ABSOLUTE_TTL_MS'],
        message: 'must be at least SESSION_IDLE_TTL_MS',
      });
    }
    checkAiProviderEnv(env, ctx);
    checkStorageEnv(env, ctx);
    if (env.NODE_ENV === 'production') {
      if (!env.SESSION_COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
      if (env.TRUST_PROXY === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message: 'must name the proxy hop in production (not true/*)',
        });
      }
    }
  });

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
