import { describe, expect, it } from 'vitest';

import { redactUrl } from './index.js';

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
