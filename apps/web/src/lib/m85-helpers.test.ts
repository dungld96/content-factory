import { describe, expect, it } from 'vitest';

import { voicesFor, type TtsModelOption } from '../components/voice-profiles';
import { errorText } from './api-client';

describe('errorText (M8.5 Q6)', () => {
  it('names each broken rule after the message', () => {
    expect(
      errorText({
        ok: false,
        status: 422,
        data: null,
        message: 'The content breaks a rule.',
        details: [{ path: 'body.scenes', message: 'durations sum to 32 s; target 30 s ± 1.5 s' }],
      }),
    ).toBe('The content breaks a rule. durations sum to 32 s; target 30 s ± 1.5 s.');
    expect(errorText({ ok: false, status: 500, data: null, message: null })).toBe(
      'Request failed (HTTP 500)',
    );
  });
});

describe('voicesFor (M8.5 Q5)', () => {
  const mai: TtsModelOption = {
    modelKey: 'microsoft/mai-voice-2.1',
    label: 'MAI-Voice 2.1',
    enabled: true,
    voices: [
      'en-US-Olivia:MAI-Voice-2.1',
      'vi-VN-Grant:MAI-Voice-2.1',
      'vi-VN-Harper:MAI-Voice-2.1',
    ],
  };
  it('filters by the typed language and falls back to every voice', () => {
    expect(voicesFor(mai, 'vi')).toEqual([
      'vi-VN-Grant:MAI-Voice-2.1',
      'vi-VN-Harper:MAI-Voice-2.1',
    ]);
    expect(voicesFor(mai, 'VI-vn')).toHaveLength(2);
    expect(voicesFor(mai, 'ja')).toHaveLength(3);
    expect(voicesFor(mai, '')).toHaveLength(3);
    expect(voicesFor(undefined, 'vi')).toEqual([]);
  });
});
