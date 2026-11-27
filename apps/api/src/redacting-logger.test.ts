import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './app.factory.js';

const KEY = 'FAKE-SECRET-5c1e9b77';

describe('RedactingConsoleLogger (M7 §10)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])('never writes credentials (json: %s)', (json) => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const logger = createLogger({ LOG_LEVEL: 'debug', LOG_JSON: json });
    logger.log({ msg: 'probe', authorization: `Bearer ${KEY}`, url: `https://u:${KEY}@h.test/x` });
    logger.warn(`provider said api_key=${KEY}`);
    const error = new Error(`fetch failed for https://h.test/v1?token=${KEY}`);
    logger.error({ msg: 'request_failed', stack: error.stack });
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written.join('\n')).not.toContain(KEY);
  });
});
