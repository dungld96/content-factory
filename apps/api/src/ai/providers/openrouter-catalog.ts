// OpenRouter public model catalog → registry import plan (design package §8.1). Vendor-specific
// mapping lives here, next to the adapter wiring. Prices in the catalog are strings in USD per
// token (verification record §5); they are kept exactly as published in `sourceValue`.
import { z } from 'zod';

import { LlmParameter, UsdAmount, type PriceMetric } from '@acf/ai-core';

const pricingFields = {
  prompt: z.string().optional(),
  completion: z.string().optional(),
  request: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
  internal_reasoning: z.string().optional(),
};

const catalogModelSchema = z.object({
  id: z.string(),
  canonical_slug: z.string().nullish(),
  name: z.string(),
  context_length: z.number().int().positive().nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  pricing: z
    .object({
      ...pricingFields,
      overrides: z.array(z.record(z.string(), z.unknown())).nullish(),
    })
    .catchall(z.unknown()),
  top_provider: z
    .object({ max_completion_tokens: z.number().int().positive().nullish() })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  expiration_date: z.string().nullish(),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

const catalogSchema = z.object({ data: z.array(z.unknown()) });

/** Catalog price field → registry metric. Other fields (image, audio, web search, …) do not apply to text calls. */
const METRIC_BY_FIELD: Readonly<Record<keyof typeof pricingFields, PriceMetric>> = {
  prompt: 'input_tokens',
  completion: 'output_tokens',
  request: 'request',
  input_cache_read: 'cached_input_tokens',
  input_cache_write: 'cache_write_tokens',
  internal_reasoning: 'reasoning_tokens',
};
const IGNORED_PRICE_FIELDS = new Set(['overrides', 'discount']);

const LLM_PARAMETERS = new Set<string>(Object.values(LlmParameter));

export interface PlannedPrice {
  readonly metric: PriceMetric;
  /** Exactly as published. */
  readonly sourceValue: string;
  readonly unitPrice: UsdAmount;
  readonly minPromptTokens: number;
}

export interface PlannedModel {
  readonly modelKey: string;
  readonly canonicalSlug: string | null;
  readonly displayName: string;
  readonly supportedParameters: string[];
  readonly inputModalities: string[];
  readonly outputModalities: string[];
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly isFreeVariant: boolean;
  readonly expiresAt: Date | null;
  readonly prices: PlannedPrice[];
  /** Pricing parts the registry cannot represent; the estimate may differ from billing. */
  readonly warnings: string[];
}

export type ImportPlanEntry =
  | { readonly modelKey: string; readonly ok: true; readonly model: PlannedModel }
  | { readonly modelKey: string; readonly ok: false; readonly reason: string };

function planPrice(
  field: keyof typeof pricingFields,
  value: string,
  minPromptTokens: number,
): PlannedPrice | string {
  if (value.trim() === '-1') return 'dynamic router: price unknown up front';
  let unitPrice: UsdAmount;
  try {
    unitPrice = UsdAmount.parse(value);
  } catch {
    return `unparseable ${field} price ${JSON.stringify(value)}`;
  }
  return { metric: METRIC_BY_FIELD[field], sourceValue: value.trim(), unitPrice, minPromptTokens };
}

/** Maps one catalog entry. Refuses what the registry cannot represent safely. */
export function planCatalogModel(raw: unknown): ImportPlanEntry {
  const parsed = catalogModelSchema.safeParse(raw);
  const key = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
  if (!parsed.success)
    return {
      modelKey: key,
      ok: false,
      reason: 'catalog entry does not match the documented shape',
    };
  const m = parsed.data;
  const output = m.architecture?.output_modalities ?? [];
  if (!output.includes('text')) {
    return {
      modelKey: m.id,
      ok: false,
      reason: 'not a text-output model (LLM capability only in M2)',
    };
  }

  const prices: PlannedPrice[] = [];
  const warnings: string[] = [];
  for (const field of Object.keys(METRIC_BY_FIELD) as (keyof typeof pricingFields)[]) {
    const value = m.pricing[field];
    if (value === undefined) continue;
    const planned = planPrice(field, value, 0);
    if (typeof planned === 'string') return { modelKey: m.id, ok: false, reason: planned };
    prices.push(planned);
  }
  for (const field of Object.keys(m.pricing)) {
    if (!(field in METRIC_BY_FIELD) && !IGNORED_PRICE_FIELDS.has(field)) {
      warnings.push(`price field "${field}" not imported (does not apply to text calls)`);
    }
  }
  for (const override of m.pricing.overrides ?? []) {
    const { min_prompt_tokens: threshold, ...rest } = override;
    // Conditions (e.g. utc_days, utc_start) restrict when an override applies; the registry can
    // represent only the prompt-size tier. Other keys are price fields.
    const conditions = Object.keys(rest).filter((k) => /^(utc_|min_|max_)/.test(k));
    if (
      typeof threshold !== 'number' ||
      !Number.isSafeInteger(threshold) ||
      conditions.length > 0
    ) {
      warnings.push(
        `price override with conditions [${[typeof threshold === 'number' ? 'min_prompt_tokens' : '', ...conditions].filter(Boolean).join(', ')}] not imported`,
      );
      continue;
    }
    for (const field of Object.keys(METRIC_BY_FIELD) as (keyof typeof pricingFields)[]) {
      const value = rest[field];
      if (typeof value !== 'string') continue;
      const planned = planPrice(field, value, threshold);
      if (typeof planned === 'string') return { modelKey: m.id, ok: false, reason: planned };
      prices.push(planned);
    }
  }
  if (
    !prices.some((p) => p.metric === 'input_tokens') ||
    !prices.some((p) => p.metric === 'output_tokens')
  ) {
    return { modelKey: m.id, ok: false, reason: 'catalog has no input/output token price' };
  }

  const expires = m.expiration_date ? new Date(m.expiration_date) : null;
  return {
    modelKey: m.id,
    ok: true,
    model: {
      modelKey: m.id,
      canonicalSlug: m.canonical_slug ?? null,
      displayName: m.name,
      supportedParameters: (m.supported_parameters ?? [])
        .filter((p) => LLM_PARAMETERS.has(p))
        .sort(),
      inputModalities: m.architecture?.input_modalities ?? [],
      outputModalities: output,
      contextLength: m.context_length ?? null,
      maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
      isFreeVariant: m.id.endsWith(':free'),
      expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
      prices,
      warnings,
    },
  };
}

/** The public catalog URL (no credentials needed). */
export const catalogUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/models`;

/** Fetches the public catalog and plans the requested model keys. */
export async function planOpenRouterImport(
  baseUrl: string,
  modelKeys: readonly string[],
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<ImportPlanEntry[]> {
  let response: Response;
  try {
    response = await fetch(catalogUrl(baseUrl), {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new Error(`could not reach the OpenRouter catalog at ${catalogUrl(baseUrl)}${cause}`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`catalog request failed: HTTP ${String(response.status)}`);
  const catalog = catalogSchema.parse(await response.json());
  const byId = new Map<string, unknown>();
  for (const entry of catalog.data) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      typeof entry.id === 'string'
    ) {
      byId.set(entry.id, entry);
    }
  }
  return modelKeys.map((key) => {
    const entry = byId.get(key);
    return entry === undefined
      ? { modelKey: key, ok: false, reason: 'not in the OpenRouter catalog' }
      : planCatalogModel(entry);
  });
}
