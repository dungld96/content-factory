import { describe, expect, it } from 'vitest';

import { audioRequest, DEFAULT_AUDIO } from './render-audio';

describe('audioRequest (P4 S2)', () => {
  it('sends nothing at the defaults, so the render stays renderer v1', () => {
    expect(audioRequest(DEFAULT_AUDIO)).toBeUndefined();
    expect(
      audioRequest({ ...DEFAULT_AUDIO, scenes: { s1: { voiceOffsetMs: 0, muteMusic: false } } }),
    ).toBeUndefined();
  });

  it('sends every layer once anything differs', () => {
    expect(
      audioRequest({
        ...DEFAULT_AUDIO,
        clipAudio: true,
        sfx: [{ assetId: 'a', sceneId: 's1', offsetMs: 500, gainDb: -3 }],
        scenes: { s1: { voiceOffsetMs: 250, muteMusic: true } },
      }),
    ).toEqual({
      voice: { enabled: true, gainDb: 0 },
      music: { fadeInMs: 0, fadeOutMs: 1500, ducking: true },
      clipAudio: { enabled: true, gainDb: 0 },
      sfx: [{ assetId: 'a', sceneId: 's1', offsetMs: 500, gainDb: -3 }],
      scenes: [{ sceneId: 's1', voiceOffsetMs: 250, muteMusic: true }],
    });
  });
});
