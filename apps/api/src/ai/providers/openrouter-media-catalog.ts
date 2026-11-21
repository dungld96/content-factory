// OpenRouter video and TTS catalogs → registry import plans (M5 design §3.3, §4.2, §9.1;
// verification record docs/design/m5/openrouter-video-tts-verification.md §1.1, §2). Reads the
// public, unauthenticated catalogs; prices are kept exactly as published (cents converted to USD).
import { z } from 'zod';

import {
  UsdAmount,
  type PriceMetric,
  type TtsConstraints,
  type VideoConstraints,
} from '@acf/ai-core';

import type { PlannedImagePrice } from './openrouter-image-catalog.js';

export type PlannedPrice = PlannedImagePrice;

export interface PlannedMediaModel {
  readonly modelKey: string;
  readonly kind: 'video' | 'tts';
  readonly constraints: VideoConstraints | TtsConstraints;
  readonly prices: PlannedPrice[];
  readonly warnings: string[];
  readonly description: string | null;
}

export type MediaPlanEntry =
  | { readonly ok: true; readonly modelKey: string; readonly model: PlannedMediaModel }
  | { readonly ok: false; readonly modelKey: string; readonly reason: string };

// ----------------------------------------------------------------------------- video

export const videoModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  supported_durations: z.array(z.number().int()).nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_frame_images: z.array(z.string()).nullish(),
  generate_audio: z.boolean().nullish(),
  seed: z.boolean().nullish(),
  pricing_skus: z.record(z.string(), z.string()).nullish(),
});
export const videoModelsResponseSchema = z.object({ data: z.array(videoModelSchema) });
export type VideoModelRecord = z.infer<typeof videoModelSchema>;

/** Resolution suffix of a SKU → registry variant part (`720p`, `1080p`, `2k`, `4k`, …). */
const RES = '(\\d{3,4}p|\\d+k)';
const SECONDS = new RegExp(
  `^(image_to_video_|text_to_video_)?duration_seconds(?:_(with_audio|without_audio))?(?:_${RES})?$`,
);
const CENTS_SECONDS = new RegExp(`^cents_per_(?:second_output|video_output_second)(?:_${RES})?$`);

/** `0.17` cents → `0.0017` USD, exactly. */
function centsToUsd(cents: string): UsdAmount {
  return UsdAmount.parse(`${cents}e-2`);
}

/** Maps one SKU; `null` = not representable (kept as a warning, the reported cost covers it). */
export function parseVideoSku(
  sku: string,
  value: string,
): {
  readonly metric: PriceMetric;
  readonly variant: string;
  readonly unitPrice: UsdAmount;
  readonly priority: number;
} | null {
  const seconds = SECONDS.exec(sku);
  if (seconds) {
    const [, mode, audio, res] = seconds;
    // We always send a first frame (image-to-video): text-to-video prices do not apply.
    if (mode === 'text_to_video_') return null;
    const sound = audio === 'with_audio' ? 'audio' : audio === 'without_audio' ? 'silent' : '';
    const variant = [res?.toLowerCase(), sound].filter(Boolean).join('-');
    return {
      metric: 'output_video_seconds',
      variant,
      unitPrice: UsdAmount.parse(value),
      // An image-to-video price wins over the general one for the same variant.
      priority: mode === 'image_to_video_' ? 1 : 0,
    };
  }
  const cents = CENTS_SECONDS.exec(sku);
  if (cents) {
    return {
      metric: 'output_video_seconds',
      variant: cents[1]?.toLowerCase() ?? '',
      unitPrice: centsToUsd(value),
      priority: 0,
    };
  }
  if (sku === 'cents_per_image_input') {
    return { metric: 'input_images', variant: '', unitPrice: centsToUsd(value), priority: 0 };
  }
  if (sku === 'video_tokens' || sku === 'video_tokens_without_audio') {
    return {
      metric: 'output_video_tokens',
      variant: '',
      unitPrice: UsdAmount.parse(value),
      priority: sku === 'video_tokens_without_audio' ? 1 : 0,
    };
  }
  return null;
}

/** Turns one video catalog record into a registry plan (pure; tested with the snapshot). */
export function planVideoModel(record: VideoModelRecord): MediaPlanEntry {
  const warnings: string[] = [];
  const durations = (record.supported_durations ?? []).filter((d) => d > 0);
  const resolutions = (record.supported_resolutions ?? []).map((r) => r.toLowerCase());
  const aspectRatios = record.supported_aspect_ratios ?? [];
  if (durations.length === 0 || resolutions.length === 0) {
    return {
      ok: false,
      modelKey: record.id,
      reason: 'not a generation model (no durations or resolutions: upscaler, editor or avatar)',
    };
  }
  const constraints: VideoConstraints = {
    kind: 'video',
    durations: [...durations].sort((a, b) => a - b),
    resolutions,
    aspectRatios,
    frameImages: record.supported_frame_images ?? [],
    audio: record.generate_audio ?? null,
    seed: record.seed === true,
  };
  if (!aspectRatios.includes('9:16'))
    warnings.push('no 9:16 output: not usable for vertical video');
  if (!constraints.frameImages.includes('first_frame')) {
    warnings.push('no first-frame input: keyframes cannot be used');
  }
  const chosen = new Map<string, { price: PlannedPrice; priority: number }>();
  for (const [sku, value] of Object.entries(record.pricing_skus ?? {})) {
    let parsed;
    try {
      parsed = parseVideoSku(sku, value);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      warnings.push(`price ${sku}=${value} not representable; the reported cost covers it`);
      continue;
    }
    const key = `${parsed.metric}\u0000${parsed.variant}`;
    const current = chosen.get(key);
    if (!current || parsed.priority > current.priority) {
      chosen.set(key, {
        price: {
          metric: parsed.metric,
          variant: parsed.variant,
          sourceValue: `${sku}=${value}`,
          unitPrice: parsed.unitPrice,
        },
        priority: parsed.priority,
      });
    }
  }
  const prices = [...chosen.values()].map((c) => c.price);
  if (!prices.some((p) => p.metric === 'output_video_seconds')) {
    warnings.push('no per-second price: estimates will be unknown (explicit confirmation needed)');
  }
  return {
    ok: true,
    modelKey: record.id,
    model: {
      modelKey: record.id,
      kind: 'video',
      constraints,
      prices,
      warnings,
      description: record.description ?? null,
    },
  };
}

// ----------------------------------------------------------------------------- TTS

export const speechModelSchema = z.object({
  id: z.string().min(1),
  description: z.string().nullish(),
  pricing: z.record(z.string(), z.string().nullish()).nullish(),
  supported_voices: z.array(z.string()).nullish(),
});
export const speechModelsResponseSchema = z.object({ data: z.array(speechModelSchema) });
export type SpeechModelRecord = z.infer<typeof speechModelSchema>;

/** Providers whose TTS endpoints return PCM only (verification record §2). */
const PCM_ONLY_PREFIXES = ['google/', 'heygen/'];

const positive = (v: string | null | undefined) =>
  v !== null && v !== undefined && v !== '' && Number(v) > 0 ? v : null;

/**
 * One speech catalog record → plan. A `prompt` price without a `completion` price is per input
 * character (verified on the model pages, e.g. "$40 per M characters"); models priced by
 * prompt and completion tokens (Gemini TTS) keep token prices and get unknown estimates.
 */
export function planTtsModel(record: SpeechModelRecord): MediaPlanEntry {
  const warnings: string[] = [];
  const prompt = positive(record.pricing?.['prompt']);
  const completion = positive(record.pricing?.['completion']);
  const prices: PlannedPrice[] = [];
  if (prompt && !completion) {
    prices.push({
      metric: 'input_characters',
      variant: '',
      sourceValue: `prompt=${prompt}`,
      unitPrice: UsdAmount.parse(prompt),
    });
  } else if (prompt || completion) {
    if (prompt)
      prices.push({
        metric: 'input_tokens',
        variant: '',
        sourceValue: `prompt=${prompt}`,
        unitPrice: UsdAmount.parse(prompt),
      });
    if (completion)
      prices.push({
        metric: 'output_tokens',
        variant: '',
        sourceValue: `completion=${completion}`,
        unitPrice: UsdAmount.parse(completion),
      });
    warnings.push('priced by token: estimates will be unknown until the reported cost arrives');
  } else {
    warnings.push(
      record.id.endsWith(':free')
        ? 'free variant: not for production (quota, terms)'
        : 'no price published: estimates unknown',
    );
  }
  const mp3 = !PCM_ONLY_PREFIXES.some((p) => record.id.startsWith(p));
  if (!mp3) warnings.push('returns PCM only: stored as WAV');
  const constraints: TtsConstraints = { kind: 'tts', voices: record.supported_voices ?? [], mp3 };
  if (constraints.voices.length === 0)
    warnings.push('no voice list published: voice ids are not checked');
  return {
    ok: true,
    modelKey: record.id,
    model: {
      modelKey: record.id,
      kind: 'tts',
      constraints,
      prices,
      warnings,
      description: record.description ?? null,
    },
  };
}

// ----------------------------------------------------------------------------- fetch

const base = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

/** Plans the requested video models from the public catalog (no API key, nothing written). */
export async function planOpenRouterVideoImport(
  baseUrl: string,
  modelKeys: readonly string[],
): Promise<MediaPlanEntry[]> {
  const res = await fetch(`${base(baseUrl)}/videos/models`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`video catalog: HTTP ${String(res.status)}`);
  const catalog = videoModelsResponseSchema.parse(await res.json());
  return modelKeys.map((key) => {
    const record = catalog.data.find((m) => m.id === key);
    return record
      ? planVideoModel(record)
      : { ok: false, modelKey: key, reason: 'not in the video catalog' };
  });
}

/** Plans the requested TTS models from the public speech catalog. */
export async function planOpenRouterTtsImport(
  baseUrl: string,
  modelKeys: readonly string[],
): Promise<MediaPlanEntry[]> {
  const res = await fetch(`${base(baseUrl)}/models?output_modalities=speech`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`speech catalog: HTTP ${String(res.status)}`);
  const catalog = speechModelsResponseSchema.parse(await res.json());
  return modelKeys.map((key) => {
    const record = catalog.data.find((m) => m.id === key);
    return record
      ? planTtsModel(record)
      : { ok: false, modelKey: key, reason: 'not in the speech catalog' };
  });
}
