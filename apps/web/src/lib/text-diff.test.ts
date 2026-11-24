import { describe, expect, it } from 'vitest';

import { diffWords, hasChanges } from './text-diff';

describe('diffWords (R4 review diff)', () => {
  it('marks added and removed words', () => {
    expect(diffWords('A quick brown fox', 'A slow brown fox jumps')).toEqual([
      { kind: 'same', text: 'A ' },
      { kind: 'removed', text: 'quick ' },
      { kind: 'added', text: 'slow ' },
      { kind: 'same', text: 'brown fox ' },
      { kind: 'added', text: 'jumps' },
    ]);
  });

  it('reports no change for equal texts', () => {
    expect(hasChanges(diffWords('same text', 'same text'))).toBe(false);
    expect(hasChanges(diffWords('same text', 'same text!'))).toBe(true);
  });
});
