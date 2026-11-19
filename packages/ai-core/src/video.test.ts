import { describe, expect, it } from 'vitest';

import type { GenerationContext } from './capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from './errors.js';
import {
  chooseVideoDuration,
  ttsConstraintIssues,
  videoConstraintIssues,
  type VideoConstraints,
  type VideoRequest,
} from './media.js';
import { UsdAmount } from './money.js';
import {
  assessTtsCost,
  assessVideoCost,
  estimateVideoCost,
  ttsCharacters,
  videoPriceVariants,
  type PriceComponent,
} from './pricing.js';
import { MockTtsProvider, MockVideoProvider } from './testing/index.js';
import { CostStatus, PriceMetric } from './usage.js';

const price = (metric: PriceMetric, unit: string, variant = ''): PriceComponent => ({
  id: `${metric}:${variant}`,
  metric,
  unitPrice: UsdAmount.parse(unit),
  minPromptTokens: 0,
  variant,
  effectiveFrom: new Date('2026-11-19T00:00:00Z'),
});

describe('chooseVideoDuration (decision V5)', () => {
  it('picks the smallest supported duration that covers the scene', () => {
    expect(chooseVideoDuration(4.2, [8, 4, 6])).toBe(6);
    expect(chooseVideoDuration(6, [4, 6, 8])).toBe(6);
    expect(chooseVideoDuration(0.4, [4, 6, 8])).toBe(4);
    expect(chooseVideoDuration(3, [2, 3, 4, 5])).toBe(3);
  });
  it('returns null when the scene is longer than the model maximum', () => {
    expect(chooseVideoDuration(9, [4, 6, 8])).toBeNull();
    expect(chooseVideoDuration(5, [])).toBeNull();
  });
});

describe('videoConstraintIssues', () => {
  const veo: VideoConstraints = {
    kind: 'video',
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    frameImages: ['first_frame', 'last_frame'],
    audio: true,
    seed: true,
  };
  const req: Pick<
    VideoRequest,
    'durationSeconds' | 'resolution' | 'aspectRatio' | 'generateAudio' | 'seed' | 'firstFrame'
  > = { durationSeconds: 6, resolution: '720p', aspectRatio: '9:16', generateAudio: false };

  it('accepts what the model supports', () => {
    expect(videoConstraintIssues(req, veo)).toEqual([]);
  });
  it('lists every unsupported parameter', () => {
    expect(
      videoConstraintIssues(
        {
          ...req,
          durationSeconds: 5,
          resolution: '480p',
          aspectRatio: '1:1',
          generateAudio: true,
          seed: 1,
        },
        { ...veo, audio: false, seed: false },
      ),
    ).toEqual([
      'duration 5 s is not supported',
      'resolution 480p is not supported',
      'aspect ratio 1:1 is not supported',
      'audio generation is not supported',
      'seed is not supported',
    ]);
    expect(
      videoConstraintIssues(
        { ...req, firstFrame: { mimeType: 'image/png', bytes: new Uint8Array([1]) } },
        { ...veo, frameImages: [] },
      ),
    ).toEqual(['a first frame image is not supported']);
    expect(videoConstraintIssues(req, null)).toHaveLength(1);
  });
  it('checks TTS voices only when the catalog lists them', () => {
    expect(
      ttsConstraintIssues({ voice: 'sarah' }, { kind: 'tts', voices: ['sarah'], mp3: true }),
    ).toEqual([]);
    expect(
      ttsConstraintIssues({ voice: 'x' }, { kind: 'tts', voices: ['sarah'], mp3: true }),
    ).toHaveLength(1);
    expect(ttsConstraintIssues({ voice: 'x' }, { kind: 'tts', voices: [], mp3: true })).toEqual([]);
  });
});

describe('video cost (decision V10)', () => {
  // google/veo-3.1-lite at 2026-11-19 (verification record §1.2).
  const veoLite = [
    price(PriceMetric.OUTPUT_VIDEO_SECONDS, '0.08', 'audio'),
    price(PriceMetric.OUTPUT_VIDEO_SECONDS, '0.05', 'silent'),
    price(PriceMetric.OUTPUT_VIDEO_SECONDS, '0.05', '720p-audio'),
    price(PriceMetric.OUTPUT_VIDEO_SECONDS, '0.03', '720p-silent'),
  ];

  it('uses the most specific variant', () => {
    expect(videoPriceVariants('720p', false)).toEqual(['720p-silent', '720p', 'silent', '']);
    const est = (resolution: '720p' | '1080p', audio: boolean) =>
      estimateVideoCost({
        prices: veoLite,
        usage: { seconds: 6, inputImages: 1, resolution, audio },
      })?.toString();
    expect(est('720p', false)).toBe('0.18');
    expect(est('1080p', false)).toBe('0.3');
    expect(est('720p', true)).toBe('0.3');
    expect(est('1080p', true)).toBe('0.48');
  });

  it('adds per-input-image prices and keeps the reported cost', () => {
    const grok = [
      price(PriceMetric.OUTPUT_VIDEO_SECONDS, '0.03', '720p'),
      price(PriceMetric.INPUT_IMAGES, '0.01'),
    ];
    const assessed = assessVideoCost({
      usage: { seconds: 6, inputImages: 1, resolution: '720p', audio: false },
      prices: grok,
      reportedCost: UsdAmount.parse('0.2'),
    });
    expect(assessed.estimatedCost?.toString()).toBe('0.19');
    expect(assessed.status).toBe(CostStatus.REPORTED);
  });

  it('is unknown (never zero) for token-priced or unpriced models', () => {
    const seedance = [price(PriceMetric.OUTPUT_VIDEO_TOKENS, '0.0000035')];
    const usage = { seconds: 6, inputImages: 1, resolution: '720p' as const, audio: false };
    expect(estimateVideoCost({ prices: seedance, usage })).toBeNull();
    expect(estimateVideoCost({ prices: [], usage })).toBeNull();
    expect(assessVideoCost({ usage, prices: [], reportedCost: null }).status).toBe(
      CostStatus.UNKNOWN,
    );
  });
});

describe('TTS cost', () => {
  it('bills characters (code points)', () => {
    expect(ttsCharacters('Năm món đồ')).toBe(10);
    const assessed = assessTtsCost({
      characters: 450,
      prices: [price(PriceMetric.INPUT_CHARACTERS, '0.00004')],
      reportedCost: null,
    });
    expect([assessed.status, assessed.estimatedCost?.toString()]).toEqual([
      CostStatus.ESTIMATED,
      '0.018',
    ]);
  });
  it('is unknown for token-priced TTS', () => {
    const gemini = [
      price(PriceMetric.INPUT_TOKENS, '0.0000005'),
      price(PriceMetric.OUTPUT_TOKENS, '0.000009'),
    ];
    expect(assessTtsCost({ characters: 10, prices: gemini, reportedCost: null }).status).toBe(
      CostStatus.UNKNOWN,
    );
  });
});

const context: GenerationContext = {
  projectId: '00000000-0000-7000-8000-000000000001',
  correlationId: 'c',
  qualityTier: 'balanced',
};
const signal = () => new AbortController().signal;
const request: VideoRequest = {
  modelKey: 'mock/video',
  prompt: 'p',
  durationSeconds: 4,
  resolution: '720p',
  aspectRatio: '9:16',
  generateAudio: false,
};

describe('MockVideoProvider', () => {
  it('completes after the configured polls and counts submissions', async () => {
    const mock = new MockVideoProvider({ pollsUntilDone: 2 });
    const job = await mock.submit(request, context, signal());
    expect(job.status).toBe('pending');
    expect((await mock.poll(job.providerJobId, context, signal())).status).toBe('running');
    expect((await mock.poll(job.providerJobId, context, signal())).status).toBe('completed');
    expect(mock.submissions).toHaveLength(1);
  });

  it('plays scripted outcomes and answers for jobs of an earlier process', async () => {
    const mock = new MockVideoProvider({
      pollsUntilDone: 1,
      steps: [
        { kind: 'fail', error: 'policy' },
        { kind: 'expire' },
        {
          kind: 'submit-error',
          error: new ProviderError(ProviderErrorCode.TIMEOUT, 'lost', {
            outcome: ProviderErrorOutcome.UNKNOWN,
          }),
        },
      ],
    });
    const failed = await mock.submit(request, context, signal());
    expect(await mock.poll(failed.providerJobId, context, signal())).toMatchObject({
      status: 'failed',
      error: 'policy',
    });
    const expired = await mock.submit(request, context, signal());
    expect((await mock.poll(expired.providerJobId, context, signal())).status).toBe('expired');
    await expect(mock.submit(request, context, signal())).rejects.toBeInstanceOf(ProviderError);

    const fresh = new MockVideoProvider({
      renderClip: (spec) => Promise.resolve(new Uint8Array([spec.durationSeconds])),
    });
    expect((await fresh.poll(failed.providerJobId, context, signal())).status).toBe('completed');
    const download = await fresh.download(failed.providerJobId, 0, context, signal());
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.body) chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([4])]);
  });
});

describe('MockTtsProvider', () => {
  it('renders audio and records calls', async () => {
    const mock = new MockTtsProvider({
      steps: [{ kind: 'result', reportedCost: UsdAmount.parse('0.001') }],
    });
    const result = await mock.synthesize(
      { modelKey: 'mock/tts', text: 'Xin chào', voice: 'a' },
      context,
      signal(),
    );
    expect(result).toMatchObject({ mimeType: 'audio/mpeg', characters: 8 });
    expect(result.reportedCost?.toString()).toBe('0.001');
    expect(mock.calls).toHaveLength(1);
  });
});
