// Vendor video/TTS adapters are constructed only here (ESLint `no-restricted-imports`, M2 P6).
import type { TtsProvider, VideoProvider } from '@acf/ai-core';
import {
  OPENROUTER_PROVIDER_KEY,
  OpenRouterTtsProvider,
  OpenRouterVideoProvider,
  type OpenRouterConfig,
} from '@acf/ai-core/openrouter';
import type { AiProviderEnv } from '@acf/config';

function openRouterConfig(env: AiProviderEnv, timeoutMs: number): OpenRouterConfig | null {
  if (env.OPENROUTER_API_KEY === undefined) return null;
  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    timeoutMs,
    ...(env.OPENROUTER_APP_ATTRIBUTION && env.OPENROUTER_APP_URL && env.OPENROUTER_APP_TITLE
      ? { attribution: { url: env.OPENROUTER_APP_URL, title: env.OPENROUTER_APP_TITLE } }
      : {}),
  };
}

/** The video adapters this deployment has credentials for (M5 design §3.2). */
export function createVideoProviders(env: AiProviderEnv): ReadonlyMap<string, VideoProvider> {
  const providers = new Map<string, VideoProvider>();
  const config = openRouterConfig(env, env.OPENROUTER_VIDEO_TIMEOUT_MS);
  if (config) providers.set(OPENROUTER_PROVIDER_KEY, new OpenRouterVideoProvider(config));
  return providers;
}

/**
 * The TTS adapters this deployment has credentials for (M5 design §4.1). `pcmOnly` tells the
 * adapter which models return PCM only (from the registry constraints).
 */
export function createTtsProviders(
  env: AiProviderEnv,
  pcmOnly: (modelKey: string) => boolean = () => false,
): ReadonlyMap<string, TtsProvider> {
  const providers = new Map<string, TtsProvider>();
  const config = openRouterConfig(env, env.OPENROUTER_TTS_TIMEOUT_MS);
  if (config) providers.set(OPENROUTER_PROVIDER_KEY, new OpenRouterTtsProvider(config, pcmOnly));
  return providers;
}
