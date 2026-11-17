import { describe, expect, it } from 'vitest';

import { loadWebServerEnv } from './index.js';

describe('loadWebServerEnv', () => {
  it('defaults the API URL for local development', () => {
    expect(loadWebServerEnv({}).API_INTERNAL_URL).toBe('http://localhost:4000');
  });

  it('rejects non-http API URLs', () => {
    expect(() => loadWebServerEnv({ API_INTERNAL_URL: 'ftp://api' })).toThrow(/API_INTERNAL_URL/);
  });
});
