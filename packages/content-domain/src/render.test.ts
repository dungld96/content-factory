import { describe, expect, it } from 'vitest';

import { InvalidTransitionError, nextContentStatus } from './pipeline.js';
import { queueForKind } from './jobs.js';
import {
  RENDER_QUEUE,
  renderExecutionKey,
  renderManifestSchema,
  renderSettings,
  upscaledFrom,
  type RenderManifest,
} from './render.js';

const id = (n: number) => `0190a5b2-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scene = (n: number, w: number | null, h: number | null) => ({
  sceneId: id(n),
  sceneNumber: n,
  durationMs: 5000,
  clipAssetId: id(100 + n),
  clipDurationMs: 5000,
  clipWidth: w,
  clipHeight: h,
  keyframeAssetId: id(200 + n),
  voiceoverAssetId: null,
  voiceoverDurationMs: null,
  text: '',
  clipModel: 'google/veo-3.1-lite',
  voiceoverModel: null,
});
const manifest = (scenes = [scene(1, 720, 1280), scene(2, 1080, 1920)]): RenderManifest => ({
  storyboardVersionId: id(9),
  scenes,
  music: null,
});

describe('render status transitions (M6 design §9)', () => {
  it('renders from asset review on, reviews, exports, and returns on failure', () => {
    expect(nextContentStatus('asset_review', { type: 'render_queued' })).toBe('rendering');
    expect(nextContentStatus('rendering', { type: 'render_succeeded' })).toBe('quality_review');
    expect(
      nextContentStatus('rendering', {
        type: 'render_ended_without_result',
        previous: 'asset_review',
      }),
    ).toBe('asset_review');
    expect(nextContentStatus('quality_review', { type: 'render_approved' })).toBe('approved');
    expect(nextContentStatus('quality_review', { type: 'render_rejected' })).toBe('asset_review');
    expect(nextContentStatus('approved', { type: 'render_exported' })).toBe('exported');
    // Re-rendering after approval or export, and approving a newer render, are allowed.
    expect(nextContentStatus('exported', { type: 'render_queued' })).toBe('rendering');
    expect(nextContentStatus('approved', { type: 'render_approved' })).toBe('approved');
  });

  it('refuses to render before the scene media exist or to export before approval', () => {
    expect(() => nextContentStatus('storyboard_review', { type: 'render_queued' })).toThrow(
      InvalidTransitionError,
    );
    expect(() => nextContentStatus('quality_review', { type: 'render_exported' })).toThrow(
      InvalidTransitionError,
    );
  });

  it('allows reworking scene media after a render', () => {
    expect(nextContentStatus('approved', { type: 'image_jobs_queued' })).toBe('generating_assets');
  });
});

describe('render helpers', () => {
  it('routes render jobs to their own queue', () => {
    expect(queueForKind('render')).toBe(RENDER_QUEUE);
  });

  it('keys renders by manifest and settings (reuse), not by the order of object keys', () => {
    const m = manifest();
    const key = renderExecutionKey(m, renderSettings(true));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(
      renderExecutionKey(JSON.parse(JSON.stringify(m)) as RenderManifest, renderSettings(true)),
    ).toBe(key);
    expect(renderExecutionKey(m, renderSettings(false))).not.toBe(key);
    expect(renderExecutionKey(manifest([scene(1, 720, 1280)]), renderSettings(true))).not.toBe(key);
  });

  it('labels upscaling by the short side of the smallest clip', () => {
    expect(upscaledFrom(manifest())).toBe('720p');
    expect(upscaledFrom(manifest([scene(1, 1080, 1920)]))).toBeNull();
    expect(upscaledFrom(manifest([scene(1, null, null)]))).toBeNull();
  });

  it('validates the manifest strictly', () => {
    expect(renderManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(renderManifestSchema.safeParse({ ...manifest(), scenes: [] }).success).toBe(false);
    expect(renderManifestSchema.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
  });
});

describe('audio layers (P4 S2)', () => {
  const audio = {
    voice: { enabled: true, gainDb: 0 },
    music: { fadeInMs: 0, fadeOutMs: 1500, ducking: true },
    clipAudio: { enabled: false, gainDb: 0 },
    sfx: [],
    scenes: [],
  };

  it('keeps the M6 renderer and settings when no audio is configured', () => {
    expect(renderSettings(true)).toEqual(renderSettings(true, false));
    expect(renderSettings(true).renderer).toBe('render.v1');
    expect(renderSettings(true, true).renderer).toBe('render.v2');
  });

  it('parses M6 manifests unchanged and records every audio setting in the key', () => {
    const m = manifest();
    expect(renderManifestSchema.parse(m)).toEqual(m);
    const plain = renderExecutionKey(m, renderSettings(true));
    const mixed = renderExecutionKey({ ...m, audio }, renderSettings(true, true));
    expect(mixed).not.toBe(plain);
    const louder = renderExecutionKey(
      { ...m, audio: { ...audio, voice: { enabled: true, gainDb: 3 } } },
      renderSettings(true, true),
    );
    expect(louder).not.toBe(mixed);
    const withSfx = renderExecutionKey(
      {
        ...m,
        audio: {
          ...audio,
          sfx: [
            {
              assetId: '00000000-0000-7000-8000-0000000000e1',
              sceneNumber: 1,
              startMs: 500,
              gainDb: 0,
              licenseNote: 'own recording',
            },
          ],
        },
      },
      renderSettings(true, true),
    );
    expect(withSfx).not.toBe(mixed);
  });
});
