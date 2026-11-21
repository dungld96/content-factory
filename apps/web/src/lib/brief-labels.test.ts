import { describe, expect, it } from 'vitest';

import { briefFieldLabel, briefIssueText } from './brief-labels';

describe('brief issue labels (UX review D2)', () => {
  it('uses readable field names instead of raw paths', () => {
    expect(
      briefIssueText({ path: 'brief.audience', message: 'not set; the model will choose' }),
    ).toBe('Audience not set: the model will choose.');
    expect(briefIssueText({ path: 'brief.topic', message: 'is required' })).toBe(
      'Topic is required.',
    );
    expect(briefFieldLabel('brief.callToAction')).toBe('Call to action');
    expect(briefFieldLabel('brief.productAssetIds.1')).toBe('Product photos');
  });

  it('falls back to a readable last segment', () => {
    expect(briefFieldLabel('brief.someNewField')).toBe('Some new field');
  });
});
