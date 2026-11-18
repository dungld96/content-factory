import { describe, expect, it } from 'vitest';

import {
  buildImagePrompt,
  imageJobInputSchema,
  missingGates,
  nextContentStatus,
  sceneContentHash,
  type ImageScene,
} from './index.js';

const scene: ImageScene = {
  sceneNumber: 2,
  shotType: 'close-up',
  cameraAngle: 'eye-level',
  visualDescription: 'A hand places a charger on a wooden desk',
  imagePrompt: 'Wireless charger on a tidy wooden desk, morning light',
  negativePrompt: 'blurry, text',
  characterVersionId: null,
  environmentVersionId: '32000000-0000-7000-8000-000000000001',
};

describe('sceneContentHash', () => {
  const hash = (s: ImageScene, refs: string[] = ['b', 'a'], aspectRatio = '9:16') =>
    sceneContentHash({ scene: s, aspectRatio, referenceAssetIds: refs });

  it('ignores the scene number and reference order, so moved but unchanged scenes reuse images', () => {
    expect(hash({ ...scene, sceneNumber: 5 }, ['a', 'b'])).toBe(hash(scene));
  });

  it('changes with anything the image depends on', () => {
    const base = hash(scene);
    expect(hash({ ...scene, imagePrompt: 'Different' })).not.toBe(base);
    expect(hash({ ...scene, negativePrompt: '' })).not.toBe(base);
    expect(hash(scene, ['a'])).not.toBe(base);
    expect(hash(scene, ['b', 'a'], '1:1')).not.toBe(base);
  });
});

describe('buildImagePrompt (image.v1)', () => {
  it('builds a deterministic prompt from the scene, with consistency and negative cues', () => {
    const prompt = buildImagePrompt({
      scene,
      characterName: null,
      environmentName: 'Home office',
      aspectRatio: '9:16',
      hasReferences: true,
    });
    expect(prompt).toBe(
      [
        'Wireless charger on a tidy wooden desk, morning light',
        'Scene: A hand places a charger on a wooden desk',
        'Shot: close-up, eye-level angle. Vertical-video frame, aspect ratio 9:16.',
        'Setting: "Home office", consistent with the reference image(s).',
        'No text, captions, logos or watermarks in the image.',
        'Avoid: blurry, text',
      ].join('\n'),
    );
  });
});

describe('image job input', () => {
  it('caps candidates at 4 and requires a scene hash', () => {
    const input = {
      storyboardVersionId: '63000000-0000-7000-8000-000000000001',
      sceneId: '64000000-0000-7000-8000-000000000001',
      scene,
      characterName: null,
      environmentName: null,
      aspectRatio: '9:16',
      resolution: '2K',
      count: 4,
      seed: null,
      references: [],
      sceneHash: 'a'.repeat(64),
      zeroDataRetention: false,
      qualityTier: 'balanced',
    };
    expect(imageJobInputSchema.safeParse(input).success).toBe(true);
    expect(imageJobInputSchema.safeParse({ ...input, count: 5 }).success).toBe(false);
    expect(imageJobInputSchema.safeParse({ ...input, sceneHash: 'x' }).success).toBe(false);
  });
});

describe('image pipeline (M4)', () => {
  it('needs an approved storyboard to start (stage descriptor, R1)', () => {
    expect(missingGates('short_video', 'images', new Set(['script_approved']))).toEqual([
      'storyboard_approved',
    ]);
    expect(missingGates('short_video', 'images', new Set(['storyboard_approved']))).toEqual([]);
    expect(missingGates('short_video', 'storyboard', new Set())).toEqual(['script_approved']);
  });

  it('moves storyboard_review → generating_assets → asset_review', () => {
    expect(nextContentStatus('storyboard_review', { type: 'image_jobs_queued' })).toBe(
      'generating_assets',
    );
    expect(nextContentStatus('generating_assets', { type: 'image_jobs_queued' })).toBe(
      'generating_assets',
    );
    expect(
      nextContentStatus('generating_assets', {
        type: 'image_jobs_settled',
        hasCandidates: true,
        previous: 'storyboard_review',
      }),
    ).toBe('asset_review');
  });

  it('returns to the starting status when no candidate exists after the jobs end', () => {
    expect(
      nextContentStatus('generating_assets', {
        type: 'image_jobs_settled',
        hasCandidates: false,
        previous: 'storyboard_review',
      }),
    ).toBe('storyboard_review');
    expect(() => nextContentStatus('script_review', { type: 'image_jobs_queued' })).toThrow();
  });

  it('allows reworking script or storyboard from asset_review', () => {
    expect(nextContentStatus('asset_review', { type: 'script_job_queued' })).toBe('scripting');
    expect(nextContentStatus('asset_review', { type: 'storyboard_job_queued' })).toBe(
      'storyboarding',
    );
  });
});
