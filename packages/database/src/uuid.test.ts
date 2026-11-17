import { describe, expect, it } from 'vitest';

import { uuidv7 } from './uuid.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 ids carrying the timestamp', () => {
    const ms = Date.UTC(2026, 10, 17, 12, 0, 0);
    const id = uuidv7(ms + 10_000);
    expect(id).toMatch(V7);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms + 10_000);
  });

  it('is strictly increasing within one process, even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
