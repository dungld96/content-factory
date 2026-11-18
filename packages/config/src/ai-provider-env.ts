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
  /** Send app attribution headers (public rankings). Off by default: they identify the deployment. */
  OPENROUTER_APP_ATTRIBUTION: booleanStringSchema.default(false),
  OPENROUTER_APP_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
  OPENROUTER_APP_TITLE: z.preprocess(
    emptyAsUndefined,
    z.string().trim().min(1).max(120).optional(),
  ),
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
  if (env.NODE_ENV === 'production' && !env.OPENROUTER_BASE_URL.startsWith('https:')) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPENROUTER_BASE_URL'],
      message: 'must use https in production',
    });
  }
}
