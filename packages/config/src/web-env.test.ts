import { describe, expect, it } from 'vitest';

import { loadWebServerEnv } from './index.js';

describe('loadWebServerEnv', () => {
  it('defaults the API URL for local development', () => {
    expect(loadWebServerEnv({}).API_INTERNAL_URL).toBe('http://localhost:4000');
  });

  it('rejects non-http API URLs', () => {
    expect(() => loadWebServerEnv({ API_INTERNAL_URL: 'ftp://api' })).toThrow(/API_INTERNAL_URL/);
  });

  it('never carries provider API keys into the web configuration (M2 design §8.3)', () => {
    const env = loadWebServerEnv({ OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789' });
    expect(Object.keys(env).filter((key) => key.includes('OPENROUTER'))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain('sk-or-v1');
  });
});
