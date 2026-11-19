import { describe, expect, it } from 'vitest';

import {
  buildCaptionCues,
  checkSrt,
  chunkCaptionText,
  escapeAssText,
  toAss,
  toSrt,
} from './captions.js';

const TEXT = 'Năm món đồ nhỏ giúp bàn làm việc của bạn gọn gàng hơn mỗi ngày.';

describe('chunkCaptionText', () => {
  it('wraps at word boundaries into cues of at most two 32-character lines', () => {
    expect(chunkCaptionText(TEXT)).toEqual([
      ['Năm món đồ nhỏ giúp bàn làm việc', 'của bạn gọn gàng hơn mỗi ngày.'],
    ]);
    const long = `${TEXT} ${TEXT}`;
    const cues = chunkCaptionText(long);
    expect(cues).toHaveLength(2);
    for (const cue of cues) {
      expect(cue.length).toBeLessThanOrEqual(2);
      for (const line of cue) expect(Array.from(line).length).toBeLessThanOrEqual(32);
    }
    expect(cues.flat().join(' ')).toBe(long);
  });

  it('keeps an overlong word on its own line and ignores blank text', () => {
    expect(chunkCaptionText('a supercalifragilisticexpialidocious-ish-word b', 10)).toEqual([
      ['a', 'supercalifragilisticexpialidocious-ish-word'],
      ['b'],
    ]);
    expect(chunkCaptionText('   ')).toEqual([]);
  });
});

describe('buildCaptionCues', () => {
  it('times cues per scene in proportion to their characters, within the speech', () => {
    const cues = buildCaptionCues([
      { startMs: 0, text: `${TEXT} ${TEXT}`, speechMs: 6000 },
      { startMs: 7000, text: '', speechMs: 0 },
      { startMs: 9000, text: 'Ngắn.', speechMs: 800 },
    ]);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 3000],
      [3000, 6000],
      [9000, 9800],
    ]);
  });
});

describe('SRT', () => {
  it('writes numbered cues with millisecond times and validates them', () => {
    const cues = buildCaptionCues([{ startMs: 1500, text: TEXT, speechMs: 2250 }]);
    const srt = toSrt(cues);
    expect(srt).toBe(
      '1\n00:00:01,500 --> 00:00:03,750\nNăm món đồ nhỏ giúp bàn làm việc\ncủa bạn gọn gàng hơn mỗi ngày.\n',
    );
    expect(checkSrt(srt, 4000)).toEqual({ cues: 1, issues: [] });
  });

  it('reports bad numbering, inverted or overlapping times and cues past the end', () => {
    const bad = [
      '2\n00:00:01,000 --> 00:00:00,500\nx\n',
      '2\n00:00:00,400 --> 00:00:05,000\ny\n',
    ].join('\n');
    expect(checkSrt(bad, 4000).issues).toEqual([
      'cue 1: bad sequence number',
      'cue 1: ends before it starts',
      'cue 2: overlaps the previous cue',
      'cue 2: ends after the video',
    ]);
  });
});

describe('ASS', () => {
  it('cannot be steered by caption text (no override blocks or escapes)', () => {
    expect(escapeAssText('{\\pos(0,0)}hi\\N\nthere')).toBe('｛⧵pos(0,0)｝hi⧵N there');
  });

  it('writes a 1080×1920 script with the bundled font, captions above the platform UI', () => {
    const ass = toAss(buildCaptionCues([{ startMs: 0, text: TEXT, speechMs: 3000 }]));
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920');
    expect(ass).toContain('Style: Caption,Be Vietnam Pro SemiBold,64,');
    expect(ass).toMatch(/,2,60,60,538,1\n/); // bottom-centred, baseline at 72 % of the height
    expect(ass).toContain(
      'Dialogue: 0,0:00:00.00,0:00:03.00,Caption,,0,0,0,,Năm món đồ nhỏ giúp bàn làm việc\\Ncủa bạn gọn gàng hơn mỗi ngày.',
    );
  });
});
