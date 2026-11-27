// Vendor image adapters are constructed only here (ESLint `no-restricted-imports`, M2 P6).
import type { ImageProvider } from '@acf/ai-core';
import { MIXROUTE_PROVIDER_KEY, MixRouteImageProvider } from '@acf/ai-core/mixroute';
import { OPENROUTER_PROVIDER_KEY, OpenRouterImageProvider } from '@acf/ai-core/openrouter';
import type { AiProviderEnv } from '@acf/config';

/** The image adapters this deployment has credentials for (M4 design §3.2; P5). */
export function createImageProviders(env: AiProviderEnv): ReadonlyMap<string, ImageProvider> {
  const providers = new Map<string, ImageProvider>();
  if (env.OPENROUTER_API_KEY !== undefined) {
    providers.set(
      OPENROUTER_PROVIDER_KEY,
      new OpenRouterImageProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        timeoutMs: env.OPENROUTER_IMAGE_TIMEOUT_MS,
        ...(env.OPENROUTER_APP_ATTRIBUTION && env.OPENROUTER_APP_URL && env.OPENROUTER_APP_TITLE
          ? { attribution: { url: env.OPENROUTER_APP_URL, title: env.OPENROUTER_APP_TITLE } }
          : {}),
      }),
    );
  }
  if (env.MIXROUTE_API_KEY !== undefined) {
    providers.set(
      MIXROUTE_PROVIDER_KEY,
      new MixRouteImageProvider({
        apiKey: env.MIXROUTE_API_KEY,
        baseUrl: env.MIXROUTE_BASE_URL,
        timeoutMs: env.MIXROUTE_IMAGE_TIMEOUT_MS,
      }),
    );
  }
  return providers;
}
