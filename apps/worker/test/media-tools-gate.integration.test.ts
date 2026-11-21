import { describe, expect, it } from 'vitest';

import { DEFAULT_MEDIA_TOOLS, type MediaToolsStatus } from '@acf/media';

import { MEDIA_TOOLS_RECHECK_MS, MediaToolsGate } from '../src/media-tools-gate.js';

function gate(results: MediaToolsStatus[]) {
  let clock = 0;
  const calls: number[] = [];
  const g = new MediaToolsGate(
    DEFAULT_MEDIA_TOOLS,
    () => {
      calls.push(clock);
      return Promise.resolve(
        results[Math.min(calls.length - 1, results.length - 1)] as MediaToolsStatus,
      );
    },
    () => clock,
  );
  return { g, calls, advance: (ms: number) => (clock += ms) };
}

const OK = { ffmpeg: 'ffmpeg version 7.1', ffprobe: 'ffprobe version 7.1' };

describe('MediaToolsGate (P3d R6)', () => {
  it('names the missing tools', async () => {
    expect(await gate([{ ffmpeg: null, ffprobe: null }]).g.missing()).toBe('FFmpeg and FFprobe');
    expect(await gate([{ ffmpeg: 'v', ffprobe: null }]).g.missing()).toBe('FFprobe');
    expect(await gate([OK]).g.missing()).toBeNull();
  });

  it('reuses a good result for five minutes, then checks again', async () => {
    const t = gate([OK]);
    await t.g.missing();
    t.advance(MEDIA_TOOLS_RECHECK_MS - 1);
    await t.g.missing();
    expect(t.calls).toHaveLength(1);
    t.advance(1);
    await t.g.missing();
    expect(t.calls).toHaveLength(2);
  });

  it('checks again on every call while a tool is missing, so installing needs no restart', async () => {
    const t = gate([{ ffmpeg: 'v', ffprobe: null }, OK]);
    expect(await t.g.missing()).toBe('FFprobe');
    expect(await t.g.missing()).toBeNull();
    expect(t.calls).toHaveLength(2);
  });
});
