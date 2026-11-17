import { describe, expect, it } from 'vitest';

import { paginationQuerySchema } from './pagination.js';

describe('paginationQuerySchema', () => {
  it('defaults the limit and coerces query strings', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { cursor: '' }, { other: 'x' }])(
    'rejects %o',
    (query) => {
      expect(paginationQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});
