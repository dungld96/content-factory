/**
 * DI token for the LLM adapters configured in this deployment, keyed by registry provider key
 * (`ReadonlyMap<string, LlmProvider>`). Business code receives adapters only through this token
 * and the `LlmProvider` interface (ADR-0004, design package §3.2).
 */
export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');
