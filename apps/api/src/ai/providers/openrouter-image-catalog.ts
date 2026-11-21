// OpenRouter image model catalog → registry import plan (M4 design §3.3; verification record
// docs/design/m4/openrouter-image-verification.md §1–§2). Reads the public, unauthenticated
// endpoints `GET /images/models/{id}/endpoints`; prices are kept exactly as published.
import { z } from 'zod';

import { UsdAmount, type ImageConstraints, type PriceMetric } from '@acf/ai-core';

const descriptorSchema = z.union([
  z.object({ type: z.literal('enum'), values: z.array(z.string()) }),
  z.object({ type: z.literal('range'), min: z.number(), max: z.number() }),
  z.object({ type: z.literal('boolean') }),
  z.object({ type: z.string() }).loose(),
]);

const endpointSchema = z.object({
  provider_slug: z.string(),
  provider_tag: z.string().nullish(),
  supported_parameters: z.record(z.string(), descriptorSchema).default({}),
  pricing: z
    .array(
      z.object({
        billable: z.string(),
        unit: z.string(),
        cost_usd: z.number().nonnegative(),
        variant: z.string().nullish(),
      }),
    )
    .default([]),
});

export const imageEndpointsResponseSchema = z.object({
  id: z.string(),
  endpoints: z.array(endpointSchema),
});

export interface PlannedImagePrice {
  readonly metric: PriceMetric;
  readonly variant: string;
  /** Exactly as published (per image / per megapixel / per token). */
  readonly sourceValue: string;
  /** Per registry unit (per-megapixel prices are converted to per pixel). */
  readonly unitPrice: UsdAmount;
}

export interface PlannedImageModel {
  readonly modelKey: string;
  /** The endpoint the prices and constraints come from. */
  readonly endpoint: string;
  readonly supportedParameters: string[];
  readonly constraints: ImageConstraints;
  readonly prices: PlannedImagePrice[];
  readonly warnings: string[];
}

export type ImagePlanEntry =
  | { readonly ok: true; readonly modelKey: string; readonly model: PlannedImageModel }
  | { readonly ok: false; readonly modelKey: string; readonly reason: string };

const METRIC: Readonly<Record<string, Partial<Record<string, PriceMetric>>>> = {
  output_image: {
    image: 'output_images',
    megapixel: 'output_pixels',
    token: 'output_image_tokens',
  },
  input_image: { image: 'input_images', megapixel: 'input_pixels', token: 'input_image_tokens' },
};

/** The published JSON number's shortest exact text (e.g. `0.018`, `6e-5`); parsed exactly. */
const decimal = (n: number) => String(n);

/** Turns one endpoint record into a registry plan (pure; tested with fixtures). */
export function planImageModel(
  response: z.infer<typeof imageEndpointsResponseSchema>,
  preferredEndpoint?: string,
): ImagePlanEntry {
  const endpoint =
    (preferredEndpoint && response.endpoints.find((e) => e.provider_slug === preferredEndpoint)) ??
    response.endpoints[0];
  if (!endpoint) return { ok: false, modelKey: response.id, reason: 'no endpoints' };
  const warnings: string[] = [];
  if (response.endpoints.length > 1) {
    warnings.push(
      `${String(response.endpoints.length)} endpoints; prices and limits from ${endpoint.provider_slug} (others may differ)`,
    );
  }
  const params = endpoint.supported_parameters;
  const range = (key: string, fallback: number) => {
    const d = params[key];
    return d && d.type === 'range' && 'max' in d && typeof d.max === 'number' ? d.max : fallback;
  };
  const values = (key: string): string[] => {
    const d = params[key];
    return d && d.type === 'enum' && 'values' in d && Array.isArray(d.values)
      ? (d.values as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
  };
  const constraints: ImageConstraints = {
    maxImages: Math.max(1, Math.min(10, range('n', 1))),
    maxReferences: 'input_references' in params ? Math.min(32, range('input_references', 1)) : 0,
    aspectRatios: values('aspect_ratio'),
    resolutions: values('resolution'),
    seed: 'seed' in params,
  };

  const prices: PlannedImagePrice[] = [];
  for (const p of endpoint.pricing) {
    const metric =
      METRIC[p.billable]?.[p.unit] ?? (p.unit === 'request' ? ('request' as const) : undefined);
    if (!metric) {
      warnings.push(`price ${p.billable}/${p.unit} not representable; reported cost covers it`);
      continue;
    }
    const variant = (p.variant ?? '').toLowerCase();
    if (!/^[a-z0-9._-]{0,32}$/.test(variant)) {
      warnings.push(`price variant ${JSON.stringify(p.variant)} skipped`);
      continue;
    }
    const sourceValue = decimal(p.cost_usd);
    // Per megapixel → per pixel (exact decimal shift; NUMERIC(38,18) keeps it).
    const unitPrice = UsdAmount.parse(p.unit === 'megapixel' ? `${sourceValue}e-6` : sourceValue);
    prices.push({ metric, variant, sourceValue, unitPrice });
  }
  if (!prices.some((p) => p.metric.startsWith('output_'))) {
    warnings.push('no output price: estimates will be unknown');
  }
  return {
    ok: true,
    modelKey: response.id,
    model: {
      modelKey: response.id,
      endpoint: endpoint.provider_slug,
      supportedParameters: Object.keys(params).sort(),
      constraints,
      prices,
      warnings,
    },
  };
}

export const imageEndpointsUrl = (baseUrl: string, modelKey: string) =>
  `${baseUrl.replace(/\/+$/, '')}/images/models/${modelKey}/endpoints`;

/** Fetches and plans each model (public catalog; no API key, nothing written). */
export async function planOpenRouterImageImport(
  baseUrl: string,
  modelKeys: readonly string[],
  preferredEndpoint?: string,
): Promise<ImagePlanEntry[]> {
  const plan: ImagePlanEntry[] = [];
  for (const modelKey of modelKeys) {
    if (!/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(modelKey)) {
      plan.push({ ok: false, modelKey, reason: 'not a model key (author/slug)' });
      continue;
    }
    const response = await fetch(imageEndpointsUrl(baseUrl, modelKey), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (response.status === 404) {
      plan.push({ ok: false, modelKey, reason: 'not in the image catalog' });
      continue;
    }
    if (!response.ok) throw new Error(`catalog HTTP ${String(response.status)} for ${modelKey}`);
    const parsed = imageEndpointsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      plan.push({ ok: false, modelKey, reason: 'unexpected endpoint record shape' });
      continue;
    }
    plan.push(planImageModel(parsed.data, preferredEndpoint));
  }
  return plan;
}
