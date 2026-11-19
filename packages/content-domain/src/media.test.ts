import { describe, expect, it } from 'vitest';

import { queueForKind, videoPollOptions } from './jobs.js';
import {
  AUDIO_GENERATION_QUEUE,
  buildVideoPrompt,
  clipContentHash,
  VIDEO_GENERATION_QUEUE,
  videoJobInputSchema,
  videoPollDelayMs,
  voiceoverContentHash,
} from './media.js';

const scene = {
  sceneNumber: 1,
  durationSeconds: 4,
  videoPrompt: 'Slow push in on the gadget',
  cameraMovement: 'dolly in',
  characterAction: 'Khánh lifts the gadget',
  visualDescription: 'A tidy desk at dawn',
};
const clip = {
  scene,
  keyframeAssetId: '0190a5b2-0000-7000-8000-000000000001',
  modelId: '0190a5b2-0000-7000-8000-000000000002',
  durationSeconds: 4,
  resolution: '720p',
  aspectRatio: '9:16',
  generateAudio: false,
};

describe('video polling (decision V3)', () => {
  it('backs off 15 s, 30 s, 60 s, then +60 s up to 5 minutes', () => {
    expect([0, 1, 2, 3, 4, 6, 20].map(videoPollDelayMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 300_000,
    ]);
  });

  it('gives each poll its own BullMQ id and never lets BullMQ retry it', () => {
    expect(videoPollOptions('job-1', 3, -5)).toMatchObject({
      jobId: 'job-1-poll-3',
      delay: 0,
      attempts: 1,
    });
  });

  it('routes media kinds to their own queues', () => {
    expect(queueForKind('video_generation')).toBe(VIDEO_GENERATION_QUEUE);
    expect(queueForKind('tts_generation')).toBe(AUDIO_GENERATION_QUEUE);
  });
});

describe('clip reuse hash', () => {
  it('ignores the scene number but not what the clip depends on', () => {
    const base = clipContentHash(clip);
    expect(clipContentHash({ ...clip, scene: { ...scene, sceneNumber: 7 } })).toBe(base);
    expect(clipContentHash({ ...clip, durationSeconds: 6 })).not.toBe(base);
    expect(clipContentHash({ ...clip, keyframeAssetId: clip.modelId })).not.toBe(base);
    expect(clipContentHash({ ...clip, scene: { ...scene, videoPrompt: 'Pan left' } })).not.toBe(
      base,
    );
  });

  it('distinguishes voice settings for voice-overs', () => {
    const voice = { voice: 'a', language: 'vi', speed: null, instructions: null };
    const base = voiceoverContentHash({ text: 'Xin chào', modelId: clip.modelId, voice });
    expect(
      voiceoverContentHash({
        text: 'Xin chào',
        modelId: clip.modelId,
        voice: { ...voice, speed: 1.1 },
      }),
    ).not.toBe(base);
  });
});

describe('video.v1 prompt', () => {
  it('describes the motion and anchors the first frame, deterministically', () => {
    const prompt = buildVideoPrompt({ scene, aspectRatio: '9:16' });
    expect(prompt).toBe(buildVideoPrompt({ scene, aspectRatio: '9:16' }));
    expect(prompt.split('\n')).toEqual([
      'Slow push in on the gadget',
      'Action: Khánh lifts the gadget',
      'Camera: dolly in.',
      'Scene: A tidy desk at dawn',
      'Start exactly from the first frame and keep its subject, identity and composition. Vertical video, aspect ratio 9:16.',
      'No text, captions, logos or watermarks.',
    ]);
  });

  it('skips empty scene fields', () => {
    const prompt = buildVideoPrompt({
      scene: { ...scene, characterAction: ' ', cameraMovement: '' },
      aspectRatio: '9:16',
    });
    expect(prompt).not.toContain('Action:');
    expect(prompt).not.toContain('Camera:');
  });
});

describe('video job input', () => {
  it('rejects unknown fields and unsupported resolutions', () => {
    const input = {
      storyboardVersionId: clip.keyframeAssetId,
      sceneId: clip.modelId,
      scene,
      keyframeAssetId: clip.keyframeAssetId,
      durationSeconds: 4,
      resolution: '720p',
      aspectRatio: '9:16',
      generateAudio: false,
      seed: null,
      clipHash: clipContentHash(clip),
      qualityTier: 'balanced',
    };
    expect(videoJobInputSchema.safeParse(input).success).toBe(true);
    expect(videoJobInputSchema.safeParse({ ...input, resolution: '4k' }).success).toBe(false);
    expect(videoJobInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
  });
});
