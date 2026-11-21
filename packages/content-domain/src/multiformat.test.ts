import { describe, expect, it } from 'vitest';

import {
  briefChanged,
  CHANNEL_PLATFORMS,
  CONTENT_FORMATS,
  FORMAT_DEFINITIONS,
  INITIAL_BRIEF_REVISION,
  isFormatCompatible,
  isMasterBriefStale,
  nextBriefRevision,
  PLATFORM_PROFILES,
  platformWarnings,
  resolveVariantPlatform,
  SHORT_VIDEO_SECONDS,
  validateBrief,
  type BriefInput,
} from './index.js';

describe('format registry', () => {
  it('defines every format with the M3 short-video rules unchanged', () => {
    expect(Object.keys(FORMAT_DEFINITIONS).sort()).toEqual([...CONTENT_FORMATS].sort());
    expect(FORMAT_DEFINITIONS.short_video.durationSeconds).toEqual({ min: 5, max: 180 });
    expect(FORMAT_DEFINITIONS.short_video.durationSeconds).toBe(SHORT_VIDEO_SECONDS);
    expect(FORMAT_DEFINITIONS.short_video.aspectRatios).toEqual(['9:16', '16:9', '1:1']);
  });
});

describe('platform registry', () => {
  it('has one profile per platform enum value', () => {
    expect(Object.keys(PLATFORM_PROFILES).sort()).toEqual([...CHANNEL_PLATFORMS].sort());
  });

  it('records a source and check date for every fact it states', () => {
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      for (const fact of [profile.maxDurationSeconds, profile.aspectRatios]) {
        if (!fact) continue;
        expect(fact.sourceUrl).toMatch(/^https:\/\//);
        expect(fact.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('accepts short video on every platform (compatibility matrix)', () => {
    for (const platform of CHANNEL_PLATFORMS) {
      expect(isFormatCompatible('short_video', platform)).toBe(true);
    }
  });

  it('warns, never errors, when a spec exceeds a verified limit', () => {
    const base = { format: 'short_video', aspectRatio: '9:16' } as const;
    expect(
      platformWarnings({ ...base, platform: 'youtube_shorts', targetDurationSeconds: 180 }),
    ).toEqual([]);
    expect(
      platformWarnings({ ...base, platform: 'youtube_shorts', targetDurationSeconds: 181 }),
    ).toEqual([{ path: 'targetDurationSeconds', message: expect.stringContaining('180 s') }]);
  });

  it('does not enforce limits that are not verified', () => {
    const spec = {
      format: 'short_video',
      aspectRatio: '16:9',
      targetDurationSeconds: 600,
    } as const;
    expect(platformWarnings({ ...spec, platform: 'tiktok' })).toEqual([]);
    expect(platformWarnings({ ...spec, platform: 'other' })).toEqual([]);
  });
});

describe('brief validation with a platform', () => {
  const base: BriefInput = {
    topic: 'Desk gadgets',
    audience: 'students',
    objective: 'inform',
    tone: 'friendly',
    callToAction: 'follow',
    format: 'short_video',
    targetDurationSeconds: 170,
    language: 'en',
    aspectRatio: '9:16',
  };

  it('is unchanged without a platform', () => {
    expect(validateBrief(base).warnings).toEqual([]);
  });

  it('raises no warning for a spec within the platform limits', () => {
    const result = validateBrief({
      ...base,
      platform: 'youtube_shorts',
      targetDurationSeconds: 179,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(validateBrief({ ...base, platform: 'other' }).warnings).toEqual([]);
  });

  it('keeps the normalized brief (and so execution keys) independent of the platform', () => {
    expect(validateBrief({ ...base, platform: 'tiktok' }).normalized).toEqual(
      validateBrief(base).normalized,
    );
  });
});

describe('master brief revisions', () => {
  it('detects content changes, ignoring key order and undefined fields', () => {
    expect(briefChanged({ topic: 'a', tone: 'b' }, { tone: 'b', topic: 'a' })).toBe(false);
    expect(briefChanged({ topic: 'a' }, { topic: 'a', tone: undefined })).toBe(false);
    expect(briefChanged({ topic: 'a' }, { topic: 'b' })).toBe(true);
  });

  it('increments the revision only when the brief changes', () => {
    expect(INITIAL_BRIEF_REVISION).toBe(1);
    expect(nextBriefRevision(1, { topic: 'a' }, { topic: 'a' })).toBe(1);
    expect(nextBriefRevision(1, { topic: 'a' }, { topic: 'b' })).toBe(2);
  });

  it('marks a variant stale once its master moved past the copied revision', () => {
    expect(isMasterBriefStale(1, 1)).toBe(false);
    expect(isMasterBriefStale(1, 2)).toBe(true);
    expect(isMasterBriefStale(2, 2)).toBe(false);
  });
});

describe('variant target platform', () => {
  it('takes the channel platform when a channel is set', () => {
    expect(
      resolveVariantPlatform({ channelPlatform: 'tiktok', targetPlatform: undefined }),
    ).toEqual({
      ok: true,
      platform: 'tiktok',
    });
    expect(resolveVariantPlatform({ channelPlatform: 'tiktok', targetPlatform: 'tiktok' })).toEqual(
      {
        ok: true,
        platform: 'tiktok',
      },
    );
  });

  it('rejects an explicit platform that differs from the channel', () => {
    expect(
      resolveVariantPlatform({ channelPlatform: 'tiktok', targetPlatform: 'youtube_shorts' }),
    ).toEqual({ ok: false, code: 'PLATFORM_CHANNEL_MISMATCH' });
  });

  it('uses the explicit platform, or none, without a channel', () => {
    expect(resolveVariantPlatform({ channelPlatform: null, targetPlatform: 'other' })).toEqual({
      ok: true,
      platform: 'other',
    });
    expect(resolveVariantPlatform({ channelPlatform: null, targetPlatform: null })).toEqual({
      ok: true,
      platform: null,
    });
  });
});
