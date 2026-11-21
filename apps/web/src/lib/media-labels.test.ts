import { describe, expect, it } from 'vitest';

import { mediaTypeLabel } from './media-labels';

describe('mediaTypeLabel (UX review U6)', () => {
  it('names common types and keeps unknown ones', () => {
    expect(mediaTypeLabel('application/x-subrip')).toBe('Subtitles (SRT)');
    expect(mediaTypeLabel('video/mp4')).toBe('MP4 video');
    expect(mediaTypeLabel('model/gltf')).toBe('model/gltf');
  });
});
