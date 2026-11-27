import { describe, expect, it } from 'vitest';

import { briefFieldLabel, briefIssueText } from './brief-labels';
import { translator } from './i18n';

const en = translator('en');
const vi = translator('vi');

describe('brief issue labels (UX review D2)', () => {
  it('uses readable field names instead of raw paths', () => {
    expect(
      briefIssueText({ path: 'brief.audience', message: 'not set; the model will choose' }, en),
    ).toBe('Audience not set: the model will choose.');
    expect(briefIssueText({ path: 'brief.topic', message: 'is required' }, en)).toBe(
      'Topic is required.',
    );
    expect(briefFieldLabel('brief.callToAction', en)).toBe('Call to action');
    expect(briefFieldLabel('brief.productAssetIds.1', en)).toBe('Product photos');
  });

  it('speaks the interface language', () => {
    expect(
      briefIssueText({ path: 'brief.audience', message: 'not set; the model will choose' }, vi),
    ).toBe('Khán giả: chưa đặt, mô hình sẽ tự chọn.');
    expect(
      briefIssueText(
        { path: 'targetDurationSeconds', message: 'must be 5–180 s for a short video' },
        vi,
      ),
    ).toBe('Thời lượng video ngắn phải từ 5–180 giây.');
  });

  it('falls back to a readable last segment and the message as sent', () => {
    expect(briefFieldLabel('brief.someNewField', en)).toBe('Some new field');
    expect(briefIssueText({ path: 'brief.x', message: 'is odd' }, vi)).toBe('X is odd.');
  });
});
