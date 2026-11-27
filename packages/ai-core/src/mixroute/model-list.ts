import { z } from 'zod';

import { mixRouteEndpoint, type MixRouteConfig } from './config.js';

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

/**
 * The model ids this key may call (`GET /models`; verification record §4): free, ids only — no
 * prices, limits or parameters. Throws when MixRoute cannot be read or rejects the key.
 */
export async function listMixRouteModels(
  config: MixRouteConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const timeout = AbortSignal.timeout(Math.min(config.timeoutMs, 15_000));
  const response = await fetch(mixRouteEndpoint(config, '/models'), {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  });
  const raw = await response.text();
  if (!response.ok)
    throw new Error(`MixRoute GET /models answered HTTP ${String(response.status)}`);
  const parsed = modelListSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('MixRoute GET /models returned an unexpected body');
  return parsed.data.data.map((m) => m.id);
}
