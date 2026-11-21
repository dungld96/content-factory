import { DEFAULT_MEDIA_TOOLS, runTool, type MediaTools } from './probe.js';

/**
 * Synthetic media for mock providers and tests (no network, no cost). Real, decodable files so
 * the whole pipeline (FFprobe, storage, browser playback) runs as in production.
 */

/**
 * An H.264 MP4 of `durationSec` at `width`×`height`: the still image `imageFile` scaled and
 * padded to fit, or a solid colour when no image is given.
 */
export async function synthVideo(options: {
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
  readonly imageFile?: string;
  readonly color?: string;
  readonly tools?: MediaTools;
}): Promise<void> {
  const tools = options.tools ?? DEFAULT_MEDIA_TOOLS;
  const w = String(options.width);
  const h = String(options.height);
  const d = String(options.durationSec);
  const input = options.imageFile
    ? ['-loop', '1', '-t', d, '-i', options.imageFile]
    : ['-f', 'lavfi', '-i', `color=c=${options.color ?? '0x6558e8'}:s=${w}x${h}:d=${d}:r=24`];
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`;
  await runTool(
    tools.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...input,
      '-vf',
      fit,
      '-t',
      d,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      '--',
      options.out,
    ],
    Math.max(tools.timeoutMs, 60_000),
  );
}

/** A mono MP3 tone of `durationSec` (a stand-in for synthesized speech). */
export async function synthTone(options: {
  readonly out: string;
  readonly durationSec: number;
  readonly frequency?: number;
  readonly tools?: MediaTools;
}): Promise<void> {
  const tools = options.tools ?? DEFAULT_MEDIA_TOOLS;
  await runTool(
    tools.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${String(options.frequency ?? 440)}:duration=${String(options.durationSec)}`,
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '--',
      options.out,
    ],
    Math.max(tools.timeoutMs, 60_000),
  );
}
