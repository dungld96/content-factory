import { describe, expect, it } from 'vitest';

import { parseRange } from './range.js';

describe('parseRange', () => {
  it('parses closed, open and suffix ranges, clamped to the file', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'range', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('reports ranges outside the file as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not support (whole file is served)', () => {
    for (const header of [
      undefined,
      '',
      'bytes=0-1,5-6',
      'items=0-1',
      'bytes=-',
      'bytes=5-2',
      'bytes=a-b',
    ]) {
      expect(parseRange(header, 1000)).toEqual({ kind: 'none' });
    }
    expect(parseRange('bytes=0-1', 0)).toEqual({ kind: 'none' });
  });
});
