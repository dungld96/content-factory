import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, toPage } from './pagination.js';

const row = (n: number) => ({
  id: `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`,
  createdAt: new Date(Date.UTC(2026, 10, 17, 0, 0, n)),
});

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const position = row(1);
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each([
    'not-base64-json',
    Buffer.from('{"c":"x","i":"y"}').toString('base64url'),
    Buffer.from(
      '{"c":"2026-11-17T00:00:00.000Z","i":"0190a0b0-0000-7000-8000-000000000001","x":1}',
    ).toString('base64url'),
    Buffer.from('[]').toString('base64url'),
  ])('rejects %s with 400 INVALID_CURSOR', (cursor) => {
    let error: unknown;
    try {
      decodeCursor(cursor);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 400, response: { code: 'INVALID_CURSOR' } });
  });

  it('returns a next cursor only when an extra row was fetched', () => {
    const rows = [row(3), row(2), row(1)];
    const first = toPage(rows, 2, (r) => r.id);
    expect(first.data).toEqual([row(3).id, row(2).id]);
    expect(first.page.limit).toBe(2);
    expect(decodeCursor(first.page.nextCursor ?? '')).toEqual(row(2));

    const last = toPage(rows.slice(0, 2), 2, (r) => r.id);
    expect(last.page.nextCursor).toBeNull();
  });
});
