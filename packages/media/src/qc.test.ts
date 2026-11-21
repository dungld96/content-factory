import { describe, expect, it } from 'vitest';

import type { ProbeResult } from './probe.js';
import { evaluateQc, parseDetectors } from './qc.js';
import { DEFAULT_RENDER_SPEC } from './render.js';

const STDERR = `
[blackdetect @ 0x1] black_start:2.5 black_end:3.2 black_duration:0.7
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 4
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 3.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 7.2
[silencedetect @ 0x3] silence_start: 0.5
[silencedetect @ 0x3] silence_end: 3.4 | silence_duration: 2.9
[Parsed_ebur128_1 @ 0x4] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.6 LUFS

  True peak:
    Peak:       -1.3 dBFS
`;

const probe = (
  over: Partial<ProbeResult['streams'][number]> = {},
  durationMs = 7200,
): ProbeResult => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs,
  bitRate: 4_000_000,
  streams: [
    {
      index: 0,
      type: 'video',
      codec: 'h264',
      width: 1080,
      height: 1920,
      fps: 30,
      sampleRate: null,
      channels: null,
      durationMs,
      attachedPicture: false,
      ...over,
    },
    {
      index: 1,
      type: 'audio',
      codec: 'aac',
      width: null,
      height: null,
      fps: null,
      sampleRate: 48000,
      channels: 2,
      durationMs,
      attachedPicture: false,
    },
  ],
});

const expectations = {
  spec: DEFAULT_RENDER_SPEC,
  durationMs: 7200,
  sceneStartsMs: [0, 4000],
  heldFrames: [] as [number, number][],
  speechWindows: [[0, 3800]] as [number, number][],
};

describe('parseDetectors', () => {
  it('reads black, frozen and silent spans and the loudness summary', () => {
    expect(parseDetectors(STDERR)).toEqual({
      black: [[2500, 3200]],
      frozen: [[4000, 7200]],
      silent: [[500, 3400]],
      integratedLufs: -14.2,
      truePeakDb: -1.3,
    });
  });
});

describe('evaluateQc', () => {
  it('passes a conforming render and turns detector spans into warnings with their scene', () => {
    const report = evaluateQc(probe(), parseDetectors(STDERR), expectations);
    expect(report.passed).toBe(true);
    expect(report.findings.map((f) => [f.check, f.severity, f.scene])).toEqual([
      ['black', 'warning', 1],
      ['freeze', 'warning', 2],
      ['silence', 'warning', 1],
    ]);
    expect(report.measured).toMatchObject({ width: 1080, height: 1920, integratedLufs: -14.2 });
  });

  it('does not warn about a freeze that is a held last frame', () => {
    const report = evaluateQc(probe(), parseDetectors(STDERR), {
      ...expectations,
      heldFrames: [[4500, 7200]],
    });
    expect(report.findings.some((f) => f.check === 'freeze')).toBe(false);
  });

  it('fails wrong dimensions, codec, frame rate or duration', () => {
    const report = evaluateQc(
      probe({ width: 720, height: 1280, codec: 'hevc', fps: 24 }, 9000),
      parseDetectors(''),
      expectations,
    );
    expect(report.passed).toBe(false);
    expect(report.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toEqual([
      'video',
      'dimensions',
      'fps',
      'duration',
      'loudness',
    ]);
  });
});
