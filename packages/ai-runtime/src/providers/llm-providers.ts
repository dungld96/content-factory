// The only module that may construct vendor adapters (ESLint `no-restricted-imports`, M2 P6).
import type { LlmProvider } from '@acf/ai-core';
import { MIXROUTE_PROVIDER_KEY, MixRouteLlmProvider } from '@acf/ai-core/mixroute';
import { OPENROUTER_PROVIDER_KEY, OpenRouterLlmProvider } from '@acf/ai-core/openrouter';
import type { AiProviderEnv } from '@acf/config';

/**
 * Builds the LLM adapters this deployment has credentials for. A provider without credentials
 * is simply absent: the registry reports it as `configured: false` and routing skips it.
 */
export function createLlmProviders(env: AiProviderEnv): ReadonlyMap<string, LlmProvider> {
  const providers = new Map<string, LlmProvider>();
  if (env.OPENROUTER_API_KEY !== undefined) {
    providers.set(
      OPENROUTER_PROVIDER_KEY,
      new OpenRouterLlmProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        timeoutMs: env.OPENROUTER_TIMEOUT_MS,
        ...(env.OPENROUTER_APP_ATTRIBUTION && env.OPENROUTER_APP_URL && env.OPENROUTER_APP_TITLE
          ? { attribution: { url: env.OPENROUTER_APP_URL, title: env.OPENROUTER_APP_TITLE } }
          : {}),
      }),
    );
  }
  if (env.MIXROUTE_API_KEY !== undefined) {
    providers.set(
      MIXROUTE_PROVIDER_KEY,
      new MixRouteLlmProvider({
        apiKey: env.MIXROUTE_API_KEY,
        baseUrl: env.MIXROUTE_BASE_URL,
        timeoutMs: env.MIXROUTE_TIMEOUT_MS,
      }),
    );
  }
  return providers;
}
