/** Official API base URL (verification record §1). */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_PROVIDER_KEY = 'openrouter';

export interface OpenRouterConfig {
  /** `sk-or-v1-…`. Server-side only; never logged, never returned to clients. */
  readonly apiKey: string;
  /** Default {@link OPENROUTER_DEFAULT_BASE_URL}; tests point it at a local fixture server. */
  readonly baseUrl: string;
  /** Per-call ceiling, combined with the caller's signal and the context deadline. */
  readonly timeoutMs: number;
  /**
   * Optional app attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`). Off by default:
   * they only feed public rankings and would identify the deployment (design package §7.1).
   */
  readonly attribution?: { readonly url: string; readonly title: string };
}
