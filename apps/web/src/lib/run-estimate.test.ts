import { describe, expect, it } from 'vitest';

import type { AiModelDto, AiPriceDto, AiRouteDto } from '@acf/contracts';

import { formatEstimateUsd, mulUsd } from './money';
import { estimateRun } from './run-estimate';

const price = (metric: AiPriceDto['metric'], unitPriceUsd: string): AiPriceDto => ({
  id: crypto.randomUUID(),
  metric,
  unitPriceUsd,
  sourceValue: unitPriceUsd,
  currency: 'USD',
  minPromptTokens: 0,
  variant: '',
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  source: 'official_api',
  sourceUrl: 'https://example.test',
  capturedAt: '2026-11-01T00:00:00.000Z',
});

const model = (modelKey: string, prices: AiPriceDto[]): AiModelDto =>
  ({ modelKey, displayName: modelKey.toUpperCase(), activePrices: prices }) as AiModelDto;

const route = (task: AiRouteDto['task'], modelKey: string | null): AiRouteDto =>
  ({
    task,
    model: modelKey
      ? { id: crypto.randomUUID(), modelKey, displayName: modelKey, status: 'enabled' }
      : null,
  }) as AiRouteDto;

const models = [
  model('text', [price('input_tokens', '0.0000001'), price('output_tokens', '0.0000004')]),
  model('img', [price('output_images', '0.03')]),
  model('vid', [price('output_video_seconds', '0.08')]),
  model('tts', []),
];
const routes = [
  route('script_generation', 'text'),
  route('storyboard_generation', 'text'),
  route('image_generation', 'img'),
  route('video_generation', 'vid'),
];

describe('estimateRun', () => {
  it('prices every step from the routed models and keeps unknown cost apart', () => {
    const run = estimateRun({
      durationSeconds: 30,
      candidatesPerScene: 2,
      routes,
      models,
      voiceModelKey: 'tts',
    });
    expect(run.scenes).toBe(6);
    expect(run.lines.map((l) => [l.step, l.amountUsd])).toEqual([
      ['script', '0.0008'],
      ['storyboard', '0.0015'],
      ['keyframes', '0.36'],
      ['clips', '2.4'],
      ['voice', null],
      ['render', '0'],
    ]);
    expect(run.knownUsd).toBe('2.7623');
    expect(run.hasUnknown).toBe(true);
  });

  it('leaves out the voice-over when it is off and marks unrouted steps unknown', () => {
    const run = estimateRun({
      durationSeconds: 15,
      candidatesPerScene: 1,
      routes: routes.filter((r) => r.task !== 'video_generation'),
      models,
      voiceModelKey: null,
    });
    expect(run.lines.some((l) => l.step === 'voice')).toBe(false);
    expect(run.lines.find((l) => l.step === 'clips')?.amountUsd).toBeNull();
    expect(run.hasUnknown).toBe(true);
  });
});

describe('estimate formatting', () => {
  it('multiplies exactly and rounds estimates up', () => {
    expect(mulUsd('0.0000004', 1500)).toBe('0.0006');
    expect(formatEstimateUsd('0.0015')).toBe('~$0.002');
    expect(formatEstimateUsd('2.4')).toBe('~$2.40');
    expect(formatEstimateUsd('2.7623')).toBe('~$2.77');
    expect(formatEstimateUsd('0.36')).toBe('~$0.36');
    expect(formatEstimateUsd('0')).toBe('$0.00');
  });
});
