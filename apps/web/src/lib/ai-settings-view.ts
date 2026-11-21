import type { AiProviderDto, AiRegistryEventDto, AiRouteDto } from '@acf/contracts';

export type Readiness =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

/** Whether a task route can serve requests now, and if not, the first thing to fix. */
export function routeReadiness(route: AiRouteDto, providers: readonly AiProviderDto[]): Readiness {
  if (!route.model || !route.provider) return { ready: false, reason: 'No model routed' };
  const provider = providers.find((p) => p.key === route.provider?.key);
  if (route.provider.status !== 'enabled') return { ready: false, reason: 'Provider disabled' };
  if (!route.provider.configured) {
    return {
      ready: false,
      reason:
        provider?.kind === 'mock' ? 'Test-only provider, not active here' : 'No API key configured',
    };
  }
  if (route.model.status !== 'enabled') return { ready: false, reason: 'Model disabled' };
  return { ready: true };
}

/** What a provider's credentials look like to an operator. */
export function keyStatus(p: AiProviderDto): { readonly label: string; readonly ok: boolean } {
  if (p.kind === 'mock') {
    return {
      label: p.configured ? 'Test provider active' : 'Test provider (tests only)',
      ok: p.configured,
    };
  }
  return { label: p.configured ? 'API key configured' : 'No API key', ok: p.configured };
}

const ACTION_LABEL: Readonly<Record<string, string>> = {
  provider_status: 'Provider status',
  model_status: 'Model status',
  model_schema_mode: 'Schema mode',
  model_min_billed_seconds: 'Minimum billed seconds',
  route_set: 'Task route',
  price_added: 'Price added',
  model_imported: 'Model imported',
};

export const actionLabel = (action: string) => ACTION_LABEL[action] ?? action;

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
