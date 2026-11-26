import { PriceMetric, UsdAmount } from '@acf/ai-core';

import type { ImportPlanEntry, PlannedModel, PlannedPrice } from './openrouter-catalog.js';
import type { ImagePlanEntry, PlannedImageModel } from './openrouter-image-catalog.js';

/**
 * MixRoute's curated catalog (P5 decision G4). MixRoute's `GET /models` lists ids only (no
 * prices, limits or parameters), so the registry data comes from the official model pages, read
 * on {@link MIXROUTE_CATALOG_CHECKED_AT} (verification record `docs/design/p5/
 * mixroute-verification.md` §7). Prices are recorded as `official_page`; refresh this file and
 * re-import when MixRoute changes them. Imports create disabled models, like every import.
 */
export const MIXROUTE_CATALOG_CHECKED_AT = '2026-11-26';

export const mixRouteModelPageUrl = (pageSlug: string) => `https://mixroute.ai/models/${pageSlug}/`;

/** Request parameters the chat endpoint documents (verification record §2). */
const CHAT_PARAMETERS = ['max_tokens', 'temperature', 'top_p', 'stop', 'response_format'];

/** USD per 1M tokens as published → per token. */
const perMillion = (metric: PriceMetric, published: string, minPromptTokens = 0): PlannedPrice => ({
  metric,
  sourceValue: `${published}/1M`,
  unitPrice: UsdAmount.parse(`${published}e-6`),
  minPromptTokens,
});

interface CuratedTextModel {
  readonly pageSlug: string;
  readonly model: Omit<PlannedModel, 'canonicalSlug' | 'isFreeVariant' | 'expiresAt'>;
}

const TEXT_MODELS: readonly CuratedTextModel[] = [
  {
    pageSlug: 'claude-haiku-5-5',
    model: {
      modelKey: 'claude-haiku-5-5',
      displayName: 'Claude Haiku 5.5 (MixRoute)',
      supportedParameters: [...CHAT_PARAMETERS, 'structured_outputs'],
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      prices: [
        perMillion(PriceMetric.INPUT_TOKENS, '0.10'),
        perMillion(PriceMetric.OUTPUT_TOKENS, '0.50'),
        perMillion(PriceMetric.CACHED_INPUT_TOKENS, '0.01'),
        perMillion(PriceMetric.CACHE_WRITE_TOKENS, '0.125'),
        // "Input > 100K" tier.
        perMillion(PriceMetric.INPUT_TOKENS, '0.50', 100_001),
        perMillion(PriceMetric.OUTPUT_TOKENS, '2.50', 100_001),
        perMillion(PriceMetric.CACHED_INPUT_TOKENS, '0.05', 100_001),
        perMillion(PriceMetric.CACHE_WRITE_TOKENS, '0.625', 100_001),
      ],
      warnings: ['1-hour cache writes ($0.20/1M) are not recorded: the pipeline sends none'],
    },
  },
  {
    pageSlug: 'gemini-3-5-flash-lite',
    model: {
      modelKey: 'gemini-3.5-flash-lite',
      displayName: 'Gemini 3.5 Flash-Lite (MixRoute)',
      supportedParameters: [...CHAT_PARAMETERS, 'structured_outputs'],
      inputModalities: ['text', 'image', 'file', 'audio', 'video'],
      outputModalities: ['text'],
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      prices: [
        perMillion(PriceMetric.INPUT_TOKENS, '0.30'),
        perMillion(PriceMetric.OUTPUT_TOKENS, '1.20'),
        perMillion(PriceMetric.CACHED_INPUT_TOKENS, '0.03'),
      ],
      warnings: [
        "The model page's FAQ says pricing varies by tier; the listing shows one flat rate",
      ],
    },
  },
  {
    pageSlug: 'gemini-3-5-flash',
    model: {
      modelKey: 'gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash (MixRoute)',
      supportedParameters: [...CHAT_PARAMETERS, 'structured_outputs'],
      inputModalities: ['text', 'image', 'file', 'audio', 'video'],
      outputModalities: ['text'],
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
      prices: [
        perMillion(PriceMetric.INPUT_TOKENS, '1.50'),
        perMillion(PriceMetric.OUTPUT_TOKENS, '9.00'),
        perMillion(PriceMetric.CACHED_INPUT_TOKENS, '0.15'),
      ],
      warnings: [],
    },
  },
  {
    pageSlug: 'deepseek-v4-flash',
    model: {
      modelKey: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash (MixRoute)',
      supportedParameters: [...CHAT_PARAMETERS, 'structured_outputs'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      prices: [
        perMillion(PriceMetric.INPUT_TOKENS, '0.14'),
        perMillion(PriceMetric.OUTPUT_TOKENS, '0.28'),
        perMillion(PriceMetric.CACHED_INPUT_TOKENS, '0.0028'),
      ],
      warnings: [],
    },
  },
];

/** Gemini image models: one image per call, no seed, fixed ~1K size (verification §3b). */
const GEMINI_IMAGE_CONSTRAINTS = {
  maxImages: 1,
  // Not documented for 2.5 (Gemini 3 image models take up to 14): kept small on purpose.
  maxReferences: 3,
  aspectRatios: ['9:16', '1:1', '16:9'],
  resolutions: [],
  seed: false,
};

interface CuratedImageModel {
  readonly pageSlug: string;
  readonly model: PlannedImageModel;
}

const IMAGE_MODELS: readonly CuratedImageModel[] = [
  {
    pageSlug: 'doubao-seedream-5-5-261028',
    model: {
      modelKey: 'doubao-seedream-5-5-261028',
      endpoint: 'mixroute',
      // The adapter sends an explicit size for the ratio and tier (no seed, one image per call).
      supportedParameters: ['aspect_ratio', 'input_references', 'resolution'],
      constraints: {
        maxImages: 1,
        maxReferences: 10,
        aspectRatios: ['9:16', '1:1', '16:9'],
        resolutions: ['1.5K', '2K'],
        seed: false,
      },
      // "std" tier (≤ 2,610,000 px): every size the adapter sends is in it.
      prices: [
        {
          metric: PriceMetric.OUTPUT_IMAGES,
          variant: '',
          sourceValue: '0.0195',
          unitPrice: UsdAmount.parse('0.0195'),
        },
        {
          metric: PriceMetric.INPUT_IMAGES,
          variant: '',
          sourceValue: '0.0075',
          unitPrice: UsdAmount.parse('0.0075'),
        },
      ],
      warnings: ['Images above 2,610,000 px are billed at $0.0345; the adapter never asks for one'],
    },
  },
  {
    // Gemini native generateContent (verification record §3b).
    pageSlug: 'gemini-2-5-flash-image',
    model: {
      modelKey: 'gemini-2.5-flash-image',
      endpoint: 'mixroute',
      supportedParameters: ['aspect_ratio', 'input_references'],
      constraints: GEMINI_IMAGE_CONSTRAINTS,
      // "Each image is billed at 0.039 USD" (≈ 1,290 output tokens at $30/1M).
      prices: [
        {
          metric: PriceMetric.OUTPUT_IMAGES,
          variant: '',
          sourceValue: '0.039',
          unitPrice: UsdAmount.parse('0.039'),
        },
      ],
      warnings: [
        'Prompt and reference-image input tokens ($0.30/1M) are not in the estimate (well under $0.001 per image)',
        'Output is about 1K; there is no resolution choice',
      ],
    },
  },
];

/** Every key the curated catalog knows, by import kind (Settings › Import). */
export const MIXROUTE_CATALOG_KEYS = {
  llm: TEXT_MODELS.map((m) => m.model.modelKey),
  image: IMAGE_MODELS.map((m) => m.model.modelKey),
} as const;

/**
 * What MixRoute offers this key (`GET /models` ids), or `null` when it could not be read (no
 * key, or the call failed). Uncurated models need it: their id is checked against it.
 */
export type MixRouteAvailability = ReadonlySet<string> | null;

const NOT_FOR_KEY_WARNING =
  'MixRoute does not list this model for your key: calls will fail until your MixRoute account can use it';

/** A verified model's warnings, plus one when the key's model list lacks it. */
const curatedWarnings = (
  key: string,
  warnings: readonly string[],
  available: MixRouteAvailability,
) => (available && !available.has(key) ? [...warnings, NOT_FOR_KEY_WARNING] : [...warnings]);

const NO_PRICE_WARNING =
  'No price recorded: cost stays unknown (budgets reserve per call) until you add prices with "Add price" from the model page';

function refusedUncurated(modelKey: string, available: MixRouteAvailability) {
  return {
    modelKey,
    ok: false as const,
    reason:
      available === null
        ? 'MixRoute model list unavailable (no MIXROUTE_API_KEY, or MixRoute did not answer): only the verified models can be imported'
        : 'not offered by MixRoute for this key (check the id on mixroute.ai/models)',
  };
}

/**
 * Text models: the verified entry when there is one; otherwise any id MixRoute offers this key,
 * imported without prices and with the chat endpoint's documented parameters (P5 G4, rev. 2).
 */
export function planMixRouteTextImport(
  modelKeys: readonly string[],
  available: MixRouteAvailability = null,
): ImportPlanEntry[] {
  return modelKeys.map((key) => {
    const entry = TEXT_MODELS.find((m) => m.model.modelKey === key);
    if (entry) {
      return {
        modelKey: key,
        ok: true,
        model: {
          ...entry.model,
          canonicalSlug: null,
          isFreeVariant: false,
          expiresAt: null,
          warnings: curatedWarnings(key, entry.model.warnings, available),
        },
      };
    }
    if (!available?.has(key)) return refusedUncurated(key, available);
    return {
      modelKey: key,
      ok: true,
      model: {
        modelKey: key,
        canonicalSlug: null,
        displayName: `${key} (MixRoute)`,
        // Structured output is not verified per model: set the schema mode after a smoke test.
        supportedParameters: [...CHAT_PARAMETERS, 'structured_outputs'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        contextLength: null,
        maxOutputTokens: null,
        isFreeVariant: false,
        expiresAt: null,
        prices: [],
        warnings: [
          NO_PRICE_WARNING,
          'Not in the verified list: limits and structured-output support are unverified',
        ],
      },
    };
  });
}

/**
 * Image models: the adapter speaks the Seedream request format only, so an uncurated id must be
 * a Seedream model MixRoute offers this key; it gets Seedream's limits and no prices.
 */
export function planMixRouteImageImport(
  modelKeys: readonly string[],
  available: MixRouteAvailability = null,
): ImagePlanEntry[] {
  const seedream = IMAGE_MODELS[0]?.model;
  return modelKeys.map((key) => {
    const entry = IMAGE_MODELS.find((m) => m.model.modelKey === key);
    if (entry) {
      return {
        modelKey: key,
        ok: true,
        model: {
          ...entry.model,
          warnings: curatedWarnings(key, entry.model.warnings, available),
        },
      };
    }
    const gemini = /^gemini-.*-image/i.test(key) || /nano-banana/i.test(key);
    if (!(/seedream/i.test(key) || gemini) || !seedream) {
      return {
        modelKey: key,
        ok: false,
        reason:
          'MixRoute images support Seedream and Gemini image models only for now (other image families use other request formats)',
      };
    }
    if (!available?.has(key)) return refusedUncurated(key, available);
    return {
      modelKey: key,
      ok: true,
      model: gemini
        ? {
            modelKey: key,
            endpoint: 'mixroute',
            supportedParameters: ['aspect_ratio', 'input_references'],
            constraints: GEMINI_IMAGE_CONSTRAINTS,
            prices: [],
            warnings: [
              NO_PRICE_WARNING,
              'Not in the verified list: Gemini image request format and limits assumed',
            ],
          }
        : {
            ...seedream,
            modelKey: key,
            prices: [],
            warnings: [
              NO_PRICE_WARNING,
              'Not in the verified list: Seedream request format and limits assumed',
            ],
          },
    };
  });
}

/** The official page a model's data comes from (the model page for uncurated ids too). */
export function mixRouteSourceUrl(modelKey: string): string {
  const entry = [...TEXT_MODELS, ...IMAGE_MODELS].find((m) => m.model.modelKey === modelKey);
  return mixRouteModelPageUrl(entry?.pageSlug ?? modelKey.replace(/\./g, '-'));
}
