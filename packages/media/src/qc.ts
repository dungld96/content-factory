import {
  DEFAULT_MEDIA_TOOLS,
  probeFile,
  runTool,
  type MediaTools,
  type ProbeResult,
} from './probe.js';
import type { RenderOutputSpec } from './render.js';

/**
 * Automated quality control of a render (M6 design §8, CONTENT_PIPELINE stage 10). Errors fail
 * the render; warnings are shown to the reviewer with the scene they concern.
 */

export type QcSeverity = 'error' | 'warning';

export interface QcFinding {
  readonly check: string;
  readonly severity: QcSeverity;
  readonly message: string;
  /** 1-based scene number, when the finding is local. */
  readonly scene: number | null;
}

export interface QcExpectations {
  readonly spec: RenderOutputSpec;
  readonly durationMs: number;
  readonly sceneStartsMs: readonly number[];
  readonly heldFrames: readonly (readonly [number, number])[];
  readonly speechWindows: readonly (readonly [number, number])[];
  /** Duration tolerance (default 100 ms). */
  readonly toleranceMs?: number | undefined;
}

export interface QcReport {
  readonly passed: boolean;
  readonly findings: readonly QcFinding[];
  readonly measured: {
    readonly width: number | null;
    readonly height: number | null;
    readonly fps: number | null;
    readonly durationMs: number | null;
    readonly videoCodec: string | null;
    readonly audioCodec: string | null;
    readonly integratedLufs: number | null;
    readonly truePeakDb: number | null;
  };
}

export interface DetectedSpans {
  readonly black: readonly (readonly [number, number])[];
  readonly frozen: readonly (readonly [number, number])[];
  readonly silent: readonly (readonly [number, number])[];
  readonly integratedLufs: number | null;
  readonly truePeakDb: number | null;
}

const num = (s: string | undefined): number => Number(s);

/** Parses the stderr of one `ffmpeg -f null` pass with the detectors and `ebur128`. */
export function parseDetectors(stderr: string): DetectedSpans {
  const black: [number, number][] = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) {
    black.push([num(m[1]) * 1000, num(m[2]) * 1000]);
  }
  const pair = (startRe: RegExp, endRe: RegExp): [number, number][] => {
    const starts = [...stderr.matchAll(startRe)].map((m) => num(m[1]) * 1000);
    const ends = [...stderr.matchAll(endRe)].map((m) => num(m[1]) * 1000);
    return starts.map((s, i) => [s, ends[i] ?? Number.POSITIVE_INFINITY]);
  };
  const frozen = pair(/freeze_start:\s*([\d.]+)/g, /freeze_end:\s*([\d.]+)/g);
  const silent = pair(/silence_start:\s*([\d.]+)/g, /silence_end:\s*([\d.]+)/g);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1];
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1];
  const finite = (v: string | undefined) => (v === undefined || v === '-inf' ? null : Number(v));
  return { black, frozen, silent, integratedLufs: finite(integrated), truePeakDb: finite(peak) };
}

const sceneAt = (startsMs: readonly number[], atMs: number): number => {
  let scene = 1;
  startsMs.forEach((s, i) => {
    if (atMs >= s) scene = i + 1;
  });
  return scene;
};

const overlap = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** Pure rules over the probe and the detector output. */
export function evaluateQc(
  probe: ProbeResult,
  detected: DetectedSpans,
  expect: QcExpectations,
): QcReport {
  const findings: QcFinding[] = [];
  const add = (
    check: string,
    severity: QcSeverity,
    message: string,
    scene: number | null = null,
  ) => {
    findings.push({ check, severity, message, scene });
  };
  const video = probe.streams.find((s) => s.type === 'video' && !s.attachedPicture);
  const audio = probe.streams.find((s) => s.type === 'audio');
  const tolerance = expect.toleranceMs ?? 100;
  const { spec } = expect;

  if (!probe.formatName.split(',').includes('mp4'))
    add('container', 'error', `not an MP4 (${probe.formatName})`);
  if (!video) add('video', 'error', 'no video stream');
  else {
    if (video.codec !== 'h264')
      add('video', 'error', `video codec ${String(video.codec)}, expected h264`);
    if (video.width !== spec.width || video.height !== spec.height) {
      add(
        'dimensions',
        'error',
        `${String(video.width)}×${String(video.height)}, expected ${String(spec.width)}×${String(spec.height)}`,
      );
    }
    const fps = video.fps;
    if (fps === null || Math.abs(fps - spec.fps) > 0.01)
      add('fps', 'error', `${String(fps)} fps, expected ${String(spec.fps)}`);
  }
  if (!audio) add('audio', 'error', 'no audio stream');
  else if (audio.codec !== 'aac')
    add('audio', 'error', `audio codec ${String(audio.codec)}, expected aac`);
  const duration = probe.durationMs;
  if (duration === null || Math.abs(duration - expect.durationMs) > tolerance) {
    add(
      'duration',
      'error',
      `${String(duration)} ms, expected ${String(expect.durationMs)} ± ${String(tolerance)} ms`,
    );
  }
  if (detected.integratedLufs === null) {
    if (expect.speechWindows.length > 0) add('loudness', 'error', 'the audio is silent');
  } else if (Math.abs(detected.integratedLufs - spec.loudness.integrated) > 1) {
    add(
      'loudness',
      'warning',
      `integrated loudness ${detected.integratedLufs.toFixed(1)} LUFS, target ${String(spec.loudness.integrated)}`,
    );
  }
  for (const span of detected.black) {
    add(
      'black',
      'warning',
      `black picture ${(span[0] / 1000).toFixed(1)}–${(span[1] / 1000).toFixed(1)} s`,
      sceneAt(expect.sceneStartsMs, span[0]),
    );
  }
  for (const span of detected.frozen) {
    const end = Number.isFinite(span[1]) ? span[1] : expect.durationMs;
    const length = end - span[0];
    const held = expect.heldFrames.reduce((sum, h) => sum + overlap([span[0], end], h), 0);
    if (length - held > 1000) {
      add(
        'freeze',
        'warning',
        `frozen picture ${(span[0] / 1000).toFixed(1)}–${(end / 1000).toFixed(1)} s`,
        sceneAt(expect.sceneStartsMs, span[0]),
      );
    }
  }
  for (const span of detected.silent) {
    const end = Number.isFinite(span[1]) ? span[1] : expect.durationMs;
    for (const window of expect.speechWindows) {
      if (overlap([span[0], end], window) > 2000) {
        add(
          'silence',
          'warning',
          `silence during narration ${(span[0] / 1000).toFixed(1)}–${(end / 1000).toFixed(1)} s`,
          sceneAt(expect.sceneStartsMs, window[0]),
        );
      }
    }
  }
  return {
    passed: !findings.some((f) => f.severity === 'error'),
    findings,
    measured: {
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: video?.fps ?? null,
      durationMs: duration,
      videoCodec: video?.codec ?? null,
      audioCodec: audio?.codec ?? null,
      integratedLufs: detected.integratedLufs,
      truePeakDb: detected.truePeakDb,
    },
  };
}

/** FFprobe + one decoding pass with the detectors, then the rules. */
export async function inspectRender(
  file: string,
  expect: QcExpectations,
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
  timeoutMs = 600_000,
): Promise<QcReport> {
  const probe = await probeFile(file, tools);
  const { stderr } = await runTool(
    tools.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vf',
      'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=1',
      '-af',
      'silencedetect=n=-50dB:d=2,ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    timeoutMs,
  );
  return evaluateQc(probe, parseDetectors(stderr), expect);
}
