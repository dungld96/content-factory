// Import plans from the catalog snapshots retrieved for the M5 verification record
// (docs/design/m5/evidence/, 2026-11-19): every SKU pattern of §1.1 is exercised.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { estimateVideoCost, type PriceComponent, type VideoConstraints } from '@acf/ai-core';

import {
  parseVideoSku,
  planTtsModel,
  planVideoModel,
  speechModelsResponseSchema,
  videoModelsResponseSchema,
  type MediaPlanEntry,
} from './openrouter-media-catalog.js';

const evidence = path.resolve(import.meta.dirname, '../../../../../docs/design/m5/evidence');
const videos = videoModelsResponseSchema.parse(
  JSON.parse(readFileSync(path.join(evidence, 'openrouter-video-models-2026-11-19.json'), 'utf8')),
).data;
const speech = speechModelsResponseSchema.parse(
  JSON.parse(readFileSync(path.join(evidence, 'openrouter-tts-models-2026-11-19.json'), 'utf8')),
).data;

const plan = (id: string): MediaPlanEntry => {
  const record = videos.find((m) => m.id === id);
  if (!record) throw new Error(`missing ${id}`);
  return planVideoModel(record);
};
const voicesOf = (c: { kind: string; voices?: readonly string[] }) =>
  c.kind === 'tts' ? (c.voices ?? []) : [];
const ok = (entry: MediaPlanEntry) => {
  if (!entry.ok) throw new Error(entry.reason);
  return entry.model;
};
const asPrices = (entry: MediaPlanEntry): PriceComponent[] =>
  ok(entry).prices.map((p, i) => ({
    id: String(i),
    metric: p.metric,
    unitPrice: p.unitPrice,
    minPromptTokens: 0,
    variant: p.variant,
    effectiveFrom: new Date(0),
  }));
const sixSeconds = (entry: MediaPlanEntry, resolution: '720p' | '1080p' | '480p', audio = false) =>
  estimateVideoCost({
    prices: asPrices(entry),
    usage: { seconds: 6, inputImages: 1, resolution, audio },
  })?.toString() ?? null;

describe('parseVideoSku', () => {
  it('maps per-second SKUs to resolution/audio variants', () => {
    expect(parseVideoSku('duration_seconds', '0.1')).toMatchObject({
      metric: 'output_video_seconds',
      variant: '',
    });
    expect(parseVideoSku('duration_seconds_without_audio_720p', '0.03')).toMatchObject({
      variant: '720p-silent',
    });
    expect(parseVideoSku('duration_seconds_with_audio', '0.08')).toMatchObject({
      variant: 'audio',
    });
    expect(parseVideoSku('image_to_video_duration_seconds_1080p', '0.15')).toMatchObject({
      variant: '1080p',
      priority: 1,
    });
    expect(parseVideoSku('text_to_video_duration_seconds_720p', '0.08')).toBeNull();
  });
  it('converts cents exactly', () => {
    expect(parseVideoSku('cents_per_second_output_720p', '17')?.unitPrice.toString()).toBe('0.17');
    expect(parseVideoSku('cents_per_video_output_second_480p', '0.5')?.unitPrice.toString()).toBe(
      '0.005',
    );
    expect(parseVideoSku('cents_per_image_input', '1')).toMatchObject({ metric: 'input_images' });
  });
  it('keeps token prices and refuses special SKUs', () => {
    expect(parseVideoSku('video_tokens', '0.0000035')).toMatchObject({
      metric: 'output_video_tokens',
    });
    expect(parseVideoSku('long_duration_seconds_2k', '0.105')).toBeNull();
    expect(parseVideoSku('minimum_cents_per_generation', '56')).toBeNull();
  });
});

describe('planVideoModel (catalog snapshot 2026-11-19)', () => {
  it('reproduces the verification record estimates (5 × 6 s pilot, 720p, silent)', () => {
    expect(sixSeconds(plan('google/veo-3.1-lite'), '720p')).toBe('0.18');
    expect(sixSeconds(plan('alibaba/wan-3.0'), '720p')).toBe('0.6');
    expect(sixSeconds(plan('kwaivgi/kling-v3.0-std'), '720p')).toBe('0.504');
    // Grok: 3 ¢/s at 720p + 1 ¢ for the first frame.
    expect(sixSeconds(plan('x-ai/grok-imagine-video-1.5-lite'), '720p')).toBe('0.19');
  });

  it('prefers image-to-video prices and leaves token-priced models unknown', () => {
    expect(sixSeconds(plan('alibaba/wan-2.6'), '720p')).toBe('0.6');
    expect(sixSeconds(plan('bytedance/seedance-2.0-mini'), '720p')).toBeNull();
    expect(ok(plan('bytedance/seedance-2.0-mini')).warnings.join(' ')).toMatch(
      /no per-second price/,
    );
  });

  it('records constraints for routing and the duration rule', () => {
    expect(ok(plan('google/veo-3.1-lite')).constraints).toEqual<VideoConstraints>({
      kind: 'video',
      durations: [4, 6, 8],
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16'],
      frameImages: ['first_frame', 'last_frame'],
      audio: true,
      seed: true,
    });
  });

  it('refuses tools that are not generation models', () => {
    expect(plan('black-forest-labs/flux-video-upscale').ok).toBe(false);
    expect(ok(plan('minimax/hailuo-2.3')).warnings).toContain(
      'no 9:16 output: not usable for vertical video',
    );
  });

  it('plans every catalog model without throwing', () => {
    expect(videos.map((m) => planVideoModel(m).modelKey)).toHaveLength(videos.length);
  });
});

describe('planTtsModel (speech catalog 2026-11-19)', () => {
  const tts = (id: string) => {
    const record = speech.find((m) => m.id === id);
    if (!record) throw new Error(`missing ${id}`);
    return ok(planTtsModel(record));
  };
  it('prices character-priced models per character with their voices', () => {
    const flash = tts('elevenlabs/eleven-flash-v2.5');
    expect(flash.prices.map((p) => [p.metric, p.unitPrice.toString()])).toEqual([
      ['input_characters', '0.00004'],
    ]);
    expect(flash.constraints).toMatchObject({ kind: 'tts', mp3: true });
    expect(voicesOf(flash.constraints)).toContain('sarah');
    expect(voicesOf(tts('microsoft/mai-voice-2.1').constraints)).toContain(
      'vi-VN-Harper:MAI-Voice-2.1',
    );
  });
  it('keeps token prices for Gemini TTS, which returns PCM only', () => {
    const gemini = tts('google/gemini-3.8-flash-tts');
    expect(gemini.prices.map((p) => p.metric)).toEqual(['input_tokens', 'output_tokens']);
    expect(gemini.constraints).toMatchObject({ mp3: false });
  });
  it('flags free variants', () => {
    expect(tts('fish-audio/s2.1-pro-free:free').warnings.join(' ')).toMatch(/free variant/);
  });
});
