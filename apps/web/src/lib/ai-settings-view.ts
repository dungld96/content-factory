import type { AiProviderDto, AiRegistryEventDto, AiRouteDto } from '@acf/contracts';

import type { MessageKey } from './i18n';

/** `reason` and `label` are dictionary keys (redesign R-D6). */
export type Readiness =
  { readonly ready: true } | { readonly ready: false; readonly reason: MessageKey };

/** Whether a task route can serve requests now, and if not, the first thing to fix. */
export function routeReadiness(route: AiRouteDto, providers: readonly AiProviderDto[]): Readiness {
  if (!route.model || !route.provider) return { ready: false, reason: 'ai.reason.noModel' };
  const provider = providers.find((p) => p.key === route.provider?.key);
  if (route.provider.status !== 'enabled')
    return { ready: false, reason: 'ai.reason.providerDisabled' };
  if (!route.provider.configured) {
    return {
      ready: false,
      reason:
        provider?.kind === 'mock' ? 'ai.reason.testOnly' : 'ai.reason.noKey',
    };
  }
  if (route.model.status !== 'enabled') return { ready: false, reason: 'ai.reason.modelDisabled' };
  return { ready: true };
}

/** What a provider's credentials look like to an operator. */
export function keyStatus(p: AiProviderDto): { readonly label: MessageKey; readonly ok: boolean } {
  if (p.kind === 'mock') {
    return {
      label: p.configured ? 'ai.key.testActive' : 'ai.key.testOnly',
      ok: p.configured,
    };
  }
  return { label: p.configured ? 'ai.key.configured' : 'ai.key.none', ok: p.configured };
}

const ACTIONS = [
  'provider_status',
  'model_status',
  'model_schema_mode',
  'model_min_billed_seconds',
  'route_set',
  'price_added',
  'model_imported',
] as const;

/** The dictionary key of a registry action, or `null` for actions this build does not know. */
export const actionLabel = (action: string): MessageKey | null =>
  (ACTIONS as readonly string[]).includes(action)
    ? (`ai.action.${action as (typeof ACTIONS)[number]}` as const)
    : null;

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const show = (v: unknown): string =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : JSON.stringify(v);

/** "disabled → enabled", "mock/echo → google/gemini-…", "metric input_tokens, 0.15 …". */
export function changeSummary(e: AiRegistryEventDto): string {
  const before = record(e.before);
  const after = record(e.after);
  if (!after) return '—';
  const keys = Object.keys(after);
  const main = keys.find((k) => k === 'status' || k === 'modelKey' || k === 'schemaMode') ?? null;
  if (main && before && main in before) return `${show(before[main])} → ${show(after[main])}`;
  if (main) return show(after[main]);
  return keys.map((k) => `${k} ${show(after[k])}`).join(', ');
}
