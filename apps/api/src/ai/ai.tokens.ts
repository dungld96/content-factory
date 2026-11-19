/**
 * DI token for the LLM adapters configured in this deployment, keyed by registry provider key
 * (`ReadonlyMap<string, LlmProvider>`). Business code receives adapters only through this token
 * and the `LlmProvider` interface (ADR-0004, design package §3.2).
 */
export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

/** DI token for the image adapters (`ReadonlyMap<string, ImageProvider>`, M4). */
export const IMAGE_PROVIDERS = Symbol('IMAGE_PROVIDERS');
/** Video adapters (M5); the API only routes and prices, the worker calls them. */
export const VIDEO_PROVIDERS = Symbol('VIDEO_PROVIDERS');
/** TTS adapters (M5). */
export const TTS_PROVIDERS = Symbol('TTS_PROVIDERS');
