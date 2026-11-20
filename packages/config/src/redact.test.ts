import { describe, expect, it } from 'vitest';

import { redactSecrets, redactUrl, redactValue } from './index.js';

describe('redactUrl', () => {
  it('removes credentials and query strings', () => {
    expect(redactUrl('postgresql://user:pw@db.internal:5432/acf?sslpassword=x')).toBe(
      'postgresql://***@db.internal:5432/acf',
    );
  });

  it('keeps URLs without credentials readable', () => {
    expect(redactUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
  });

  it('does not echo unparseable input', () => {
    expect(redactUrl('not a url with secret')).toBe('[unparseable-url]');
  });
});

describe('redactSecrets / redactValue (M7 §10)', () => {
  const KEY = 'FAKE-SECRET-1234abcd';

  it.each([
    [`Authorization: Bearer ${KEY}`, 'Authorization: Bearer [redacted]'],
    [`key sk-or-v1-${KEY}`, 'key [redacted]'],
    [`GET https://user:${KEY}@host.test/v1`, 'GET https://***@host.test/v1'],
    [
      `https://s3.test/b/o?X-Amz-Signature=${KEY}&a=1`,
      'https://s3.test/b/o?X-Amz-Signature=[redacted]&a=1',
    ],
    [`{"api_key": "${KEY}"}`, '{"api_key": "[redacted]"}'],
    [`password=${KEY} next`, 'password=[redacted] next'],
  ])('masks %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('scene 3 failed: TIMEOUT after 120000 ms')).toBe(
      'scene 3 failed: TIMEOUT after 120000 ms',
    );
  });

  it('redacts secret-named fields and nested strings, including errors', () => {
    const value = redactValue({
      headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY, accept: 'json' },
      apiKey: KEY,
      inputTokens: 12,
      nested: [{ message: `token=${KEY}` }],
      error: new Error(`fetch https://u:${KEY}@h.test failed`),
    });
    expect(JSON.stringify(value)).not.toContain(KEY);
    expect(value).toMatchObject({
      headers: { Authorization: '[redacted]', 'x-api-key': '[redacted]', accept: 'json' },
      apiKey: '[redacted]',
      inputTokens: 12,
    });
  });
});
