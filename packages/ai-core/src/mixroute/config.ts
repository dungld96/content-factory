/** Official API base URL (verification record `docs/design/p5/mixroute-verification.md` §1). */
export const MIXROUTE_DEFAULT_BASE_URL = 'https://api.mixroute.ai/v1';
export const MIXROUTE_PROVIDER_KEY = 'mixroute';

export interface MixRouteConfig {
  /** Bearer token (`sk-…`). Server-side only; never logged, never returned to clients. */
  readonly apiKey: string;
  /** Default {@link MIXROUTE_DEFAULT_BASE_URL}; tests point it at a local fixture server. */
  readonly baseUrl: string;
  /** Per-call ceiling, combined with the caller's signal and the context deadline. */
  readonly timeoutMs: number;
}

export function mixRouteEndpoint(config: MixRouteConfig, path: string): string {
  return `${config.baseUrl.replace(/\/+$/, '')}${path}`;
}

export function mixRouteHeaders(config: MixRouteConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
