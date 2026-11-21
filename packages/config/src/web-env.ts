import { z } from 'zod';

import { EnvValidationError, toEnvIssues } from './errors.js';
import { nodeEnvSchema, urlWithProtocol } from './schema-helpers.js';

/**
 * Server-side environment contract for `apps/web`.
 *
 * Nothing here is exposed to the browser. Do not add `NEXT_PUBLIC_*` variables
 * that hold secrets — Next.js inlines those into client bundles.
 */
export const webServerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  /** Base URL the Next.js server uses to reach the API (server-to-server). */
  API_INTERNAL_URL: urlWithProtocol(['http:', 'https:'], 'API_INTERNAL_URL').default(
    'http://localhost:4000',
  ),
});

export type WebServerEnv = z.output<typeof webServerEnvSchema>;

/** @throws {EnvValidationError} */
export function loadWebServerEnv(
  source: Readonly<Record<string, string | undefined>>,
): WebServerEnv {
  const result = webServerEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError('web', toEnvIssues(result.error));
  }
  return result.data;
}
