/**
 * Single byte-range requests (RFC 9110 §14) for media streaming (M5 design §8): `bytes=a-b`,
 * `bytes=a-` and suffix `bytes=-n`. Anything else (several ranges, other units, bad syntax) is
 * ignored and the whole file is served, which RFC 9110 allows.
 */
export type RangeRequest =
  | { readonly kind: 'none' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

export function parseRange(header: string | undefined, size: number): RangeRequest {
  if (!header || size <= 0) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'none' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'none' };
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return { kind: 'none' };
  return { kind: 'range', start, end };
}
