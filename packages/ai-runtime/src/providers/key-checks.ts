// Vendor key checks are constructed only here (ESLint `no-restricted-imports`, M2 P6).
import type { KeyCheckResult } from '@acf/ai-core';
import { checkOpenRouterKey, OPENROUTER_PROVIDER_KEY } from '@acf/ai-core/openrouter';
import type { AiProviderEnv } from '@acf/config';

export type KeyCheck = (signal?: AbortSignal) => Promise<KeyCheckResult>;

/** Free credential checks for the providers this deployment has keys for (P1 design O3). */
export function createKeyChecks(env: AiProviderEnv): ReadonlyMap<string, KeyCheck> {
  const checks = new Map<string, KeyCheck>();
  const apiKey = env.OPENROUTER_API_KEY;
  if (apiKey !== undefined) {
    checks.set(OPENROUTER_PROVIDER_KEY, (signal) =>
      checkOpenRouterKey(
        { apiKey, baseUrl: env.OPENROUTER_BASE_URL, timeoutMs: env.OPENROUTER_TIMEOUT_MS },
        signal,
      ),
    );
  }
  return checks;
}
