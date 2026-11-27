import { z } from 'zod';

import { booleanStringSchema, urlWithProtocol } from './schema-helpers.js';

/** An unset or empty variable is absent (a `.env` line like `OPENROUTER_API_KEY=` means "not set"). */
const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * AI provider variables (M2 design package §8.3), shared by the API and the worker (M3) so both
 * validate them identically. Keys are server-only: never logged, never sent to the web app.
 */
export const aiProviderEnvShape = {
  /**
   * OpenRouter API key (`sk-or-v1-…`). Optional: when unset the provider reports
   * `configured: false` and is never called.
   */
  OPENROUTER_API_KEY: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .trim()
      .regex(/^sk-or-v1-[A-Za-z0-9_-]{16,}$/, 'must be an OpenRouter API key (sk-or-v1-…)')
      .optional(),
  ),
  /** Default: the official API. Must be https in production; tests use a local fixture server. */
  OPENROUTER_BASE_URL: urlWithProtocol(['https:', 'http:'], 'OPENROUTER_BASE_URL').default(
    'https://openrouter.ai/api/v1',
  ),
  /** Per-call ceiling in milliseconds. */
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Per image call (M4 design §3.2): image generation can take minutes. */
  OPENROUTER_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(240_000),
  /** Per video HTTP call (M5: submit, status read, download); the job itself is polled. */
  OPENROUTER_VIDEO_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Per TTS call (M5, synchronous). */
  OPENROUTER_TTS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Send app attribution headers (public rankings). Off by default: they identify the deployment. */
  OPENROUTER_APP_ATTRIBUTION: booleanStringSchema.default(false),
  OPENROUTER_APP_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
  OPENROUTER_APP_TITLE: z.preprocess(
    emptyAsUndefined,
    z.string().trim().min(1).max(120).optional(),
  ),
  /**
   * MixRoute API key (P5; `docs/design/p5/mixroute-verification.md`). Bearer token, documented as
   * `sk-…`. Optional: when unset the `mixroute` gateway reports `configured: false`.
   */
  MIXROUTE_API_KEY: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .trim()
      .regex(/^sk-[A-Za-z0-9_-]{16,}$/, 'must be a MixRoute API key (sk-…)')
      .optional(),
  ),
  /** Default: the official API. Must be https in production; tests use a local fixture server. */
  MIXROUTE_BASE_URL: urlWithProtocol(['https:', 'http:'], 'MIXROUTE_BASE_URL').default(
    'https://api.mixroute.ai/v1',
  ),
  /** Per text call in milliseconds. */
  MIXROUTE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Per image call (synchronous; Seedream can take minutes). */
  MIXROUTE_IMAGE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(240_000),
};

export type AiProviderEnv = z.output<z.ZodObject<typeof aiProviderEnvShape>>;

/** Cross-field rules for {@link aiProviderEnvShape}; call from the owning schema's superRefine. */
export function checkAiProviderEnv(
  env: AiProviderEnv & { NODE_ENV: string },
  ctx: z.RefinementCtx,
): void {
  if (env.OPENROUTER_APP_ATTRIBUTION) {
    for (const key of ['OPENROUTER_APP_URL', 'OPENROUTER_APP_TITLE'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when OPENROUTER_APP_ATTRIBUTION is true',
        });
      }
    }
  }
  if (env.NODE_ENV === 'production') {
    for (const key of ['OPENROUTER_BASE_URL', 'MIXROUTE_BASE_URL'] as const) {
      if (!env[key].startsWith('https:')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must use https in production' });
      }
    }
  }
}
