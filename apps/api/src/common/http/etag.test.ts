import { describe, expect, it } from 'vitest';

import { etagFor, expectedVersion, parseIfMatch } from './etag.js';

describe('ETag / If-Match', () => {
  const updatedAt = new Date('2026-11-17T09:00:00.123Z');

  it('formats a weak ETag from updatedAt and parses it back', () => {
    const tag = etagFor(updatedAt);
    expect(tag).toBe(`W/"${updatedAt.getTime()}"`);
    expect(parseIfMatch(tag)).toEqual(updatedAt);
    expect(parseIfMatch(`"${updatedAt.getTime()}"`)).toEqual(updatedAt);
  });

  it('treats an absent header as no precondition', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('  ')).toBeUndefined();
  });

  it.each(['*', 'W/"1", W/"2"', '"abc"', 'W/1'])('rejects %s with 412', (header) => {
    expect(() => parseIfMatch(header)).toThrow(expect.objectContaining({ status: 412 }) as Error);
  });

  it('requires the header only when REQUIRE_IF_MATCH is on (428)', () => {
    expect(expectedVersion(undefined, false)).toBeUndefined();
    expect(() => expectedVersion(undefined, true)).toThrow(
      expect.objectContaining({ status: 428 }) as Error,
    );
  });
});
