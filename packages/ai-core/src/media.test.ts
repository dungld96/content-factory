import { describe, expect, it } from 'vitest';

import {
  imageConstraintIssues,
  parseImageRequest,
  type ImageConstraints,
  type ImageRequest,
} from './media.js';

const constraints: ImageConstraints = {
  maxImages: 1,
  maxReferences: 2,
  aspectRatios: ['1:1', '9:16'],
  resolutions: ['1K', '2K'],
  seed: true,
};
const base: Pick<ImageRequest, 'aspectRatio' | 'count' | 'references'> = {
  aspectRatio: '9:16',
  count: 1,
  references: [],
};
const ref = { mimeType: 'image/png' as const, bytes: new Uint8Array([1]) };

describe('imageConstraintIssues', () => {
  it('accepts a request within the model limits', () => {
    expect(
      imageConstraintIssues({ ...base, resolution: '2K', seed: 3, references: [ref] }, constraints),
    ).toEqual([]);
  });

  it('lists every limit a request exceeds', () => {
    expect(
      imageConstraintIssues(
        { aspectRatio: '16:9', count: 2, resolution: '4K', seed: 1, references: [ref, ref, ref] },
        { ...constraints, seed: false },
      ),
    ).toEqual([
      "count 2 > the model's maximum 1",
      "3 reference image(s) > the model's maximum 2",
      'aspect ratio 16:9 is not supported',
      'resolution 4K is not supported',
      'seed is not supported',
    ]);
  });

  it('treats an undeclared aspect-ratio list as "any", but needs a declared resolution', () => {
    const open = { ...constraints, aspectRatios: [], resolutions: [] };
    expect(imageConstraintIssues({ ...base, aspectRatio: '16:9' }, open)).toEqual([]);
    expect(imageConstraintIssues({ ...base, resolution: '1K' }, open)).toEqual([
      'resolution 1K is not supported',
    ]);
    expect(imageConstraintIssues(base, null)).toHaveLength(1);
  });
});

describe('parseImageRequest', () => {
  it('rejects bad input without sending', () => {
    expect(() =>
      parseImageRequest({
        modelKey: 'm',
        prompt: ' ',
        aspectRatio: '4:3',
        count: 0,
        references: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', outcome: 'not_sent' }));
  });
});
