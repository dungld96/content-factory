import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/**
 * FFprobe wrapper (CLAUDE.md §8: FFprobe inspects media; safe argument construction). The binary
 * runs through `execFile` with an argument array: no shell, no string interpolation.
 */

export interface MediaTools {
  /** FFprobe binary (default `ffprobe` on PATH). */
  readonly ffprobePath: string;
  /** FFmpeg binary (default `ffmpeg` on PATH); only the synthetic-media helpers use it. */
  readonly ffmpegPath: string;
  /** Per-call timeout. */
  readonly timeoutMs: number;
}

export const DEFAULT_MEDIA_TOOLS: MediaTools = {
  ffprobePath: 'ffprobe',
  ffmpegPath: 'ffmpeg',
  timeoutMs: 30_000,
};

/** FFprobe/FFmpeg is not installed or not executable (API answers 503 MEDIA_TOOLS_MISSING). */
export class MediaToolsMissingError extends Error {
  override readonly name = 'MediaToolsMissingError';
}

/** The tool ran but failed (unreadable file, timeout). */
export class MediaToolError extends Error {
  override readonly name = 'MediaToolError';
}

export interface ProbedStream {
  readonly index: number;
  readonly type: 'video' | 'audio' | 'subtitle' | 'data' | 'other';
  readonly codec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** Frames per second (average), when known. */
  readonly fps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly durationMs: number | null;
  /** Cover art in audio files (MP3/M4A) is reported as a video stream with this flag. */
  readonly attachedPicture: boolean;
}

export interface ProbeResult {
  /** FFprobe `format_name`, e.g. `mov,mp4,m4a,3gp,3g2,mj2`, `mp3`, `wav`. */
  readonly formatName: string;
  readonly durationMs: number | null;
  readonly bitRate: number | null;
  readonly streams: readonly ProbedStream[];
}

const num = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === '' || v === 'N/A') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

const probeOutputSchema = z.object({
  format: z
    .object({ format_name: z.string().default(''), duration: num, bit_rate: num })
    .default({ format_name: '', duration: null, bit_rate: null }),
  streams: z
    .array(
      z.object({
        index: z.number().int(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        avg_frame_rate: z.string().optional(),
        sample_rate: num,
        channels: z.number().int().optional(),
        duration: num,
        disposition: z.record(z.string(), z.number()).optional(),
      }),
    )
    .default([]),
});

/** "30000/1001" → 29.97; "0/0" → null. */
function rate(value: string | undefined): number | null {
  if (!value) return null;
  const [n, d] = value.split('/').map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return null;
  }
  return n / d;
}

const STREAM_TYPES = new Set(['video', 'audio', 'subtitle', 'data']);
const ms = (seconds: number | null) => (seconds === null ? null : Math.round(seconds * 1000));

/** Parses FFprobe's `-print_format json -show_format -show_streams` output. */
export function parseProbeOutput(json: string): ProbeResult {
  const parsed = probeOutputSchema.parse(JSON.parse(json));
  return {
    formatName: parsed.format.format_name,
    durationMs: ms(parsed.format.duration),
    bitRate: parsed.format.bit_rate,
    streams: parsed.streams.map((s) => ({
      index: s.index,
      type: (STREAM_TYPES.has(s.codec_type ?? '') ? s.codec_type : 'other') as ProbedStream['type'],
      codec: s.codec_name ?? null,
      width: s.width ?? null,
      height: s.height ?? null,
      fps: rate(s.avg_frame_rate),
      sampleRate: s.sample_rate,
      channels: s.channels ?? null,
      durationMs: ms(s.duration),
      attachedPicture: (s.disposition?.['attached_pic'] ?? 0) === 1,
    })),
  };
}

/** Runs a media tool with an argument array; maps a missing binary to MediaToolsMissingError. */
export function runTool(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EACCES') {
            reject(new MediaToolsMissingError(`${path.basename(binary)} is not available`));
            return;
          }
          const reason = error.killed ? 'timed out' : stderr.trim().split('\n').pop();
          reject(new MediaToolError(`${path.basename(binary)} failed: ${reason ?? 'error'}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Inspects a media file. @throws {MediaToolsMissingError | MediaToolError} */
export async function probeFile(
  file: string,
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
): Promise<ProbeResult> {
  const { stdout } = await runTool(
    tools.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', file],
    tools.timeoutMs,
  );
  try {
    return parseProbeOutput(stdout);
  } catch {
    throw new MediaToolError('ffprobe returned unreadable output');
  }
}

/** Whether FFprobe can be executed (startup check). */
export async function mediaToolsAvailable(
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
): Promise<boolean> {
  try {
    await runTool(tools.ffprobePath, ['-version'], tools.timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Writes bytes to a private temporary file, runs `fn` on it, and always removes it. */
export async function withTempFile<T>(
  bytes: Uint8Array,
  extension: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acf-media-'));
  const file = path.join(dir, `input.${extension.replace(/[^a-z0-9]/gi, '')}`);
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
