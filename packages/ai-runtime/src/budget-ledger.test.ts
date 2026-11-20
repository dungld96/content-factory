import { describe, expect, it } from 'vitest';

import { OUTCOME_UNKNOWN_CODES } from '@acf/content-domain';

import { reservationOutcomeFor } from './budget-ledger.js';

describe('reservationOutcomeFor (M7 §4, P3 W5)', () => {
  it('settles on success', () => {
    expect(reservationOutcomeFor(null)).toBe('settled');
  });

  it('holds the reservation of every unconfirmed paid call (video and text/speech)', () => {
    for (const code of OUTCOME_UNKNOWN_CODES) expect(reservationOutcomeFor(code)).toBe('held');
  });

  it('releases on other failures', () => {
    expect(reservationOutcomeFor('TIMEOUT')).toBe('released');
    expect(reservationOutcomeFor('CONTENT_POLICY')).toBe('released');
  });
});
