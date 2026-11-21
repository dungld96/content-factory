import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCaptionCues,
  checkSrt,
  DEFAULT_CAPTION_STYLE,
  toAss,
  toSrt,
  type CaptionCue,
} from './captions.js';
import { DEFAULT_MEDIA_TOOLS, MediaToolError, runTool, type MediaTools } from './probe.js';

/**
 * The render pipeline (M6 design §5–§7): normalise every scene's clip to the output spec, join
 * them with hard cuts, build the narration track (voice-over per scene, silence elsewhere),
 * optionally duck a music bed under it, normalise loudness, burn in captions, encode once.
 * FFmpeg runs with argument arrays (no shell); caption text only travels through files.
 */

/** Bundled caption font (Be Vietnam Pro, SIL OFL; licence in `fonts/OFL.txt`). Fonts only: libass loads every file here. */
export const RENDER_FONTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fonts',
  'caption',
);

export interface RenderOutputSpec {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly crf: number;
  readonly preset: string;
  readonly audioBitrate: string;
  readonly sampleRate: number;
  /** Loudness target (two-pass `loudnorm`). */
  readonly loudness: {
    readonly integrated: number;
    readonly truePeak: number;
    readonly range: number;
  };
}

/** X3/X8: 1080×1920 at 30 fps, H.264 High CRF 20, AAC 192 kb/s 48 kHz, −14 LUFS / −1 dBTP. */
export const DEFAULT_RENDER_SPEC: RenderOutputSpec = {
  width: 1080,
  height: 1920,
  fps: 30,
  crf: 20,
  preset: 'medium',
  audioBitrate: '192k',
  sampleRate: 48_000,
  loudness: { integrated: -14, truePeak: -1, range: 11 },
};

export interface RenderSceneInput {
  /** Scene length in the render (the storyboard duration). */
  readonly durationMs: number;
  readonly clipFile: string;
  /** Measured clip length; a shorter clip has its last frame held (≤ 10 %, M5 validation). */
  readonly clipDurationMs: number;
  /** The scene's voice-over, or null for a scene without narration. */
  readonly voiceFile: string | null;
  readonly voiceDurationMs: number | null;
  /** Narration text, for captions ('' = none). */
  readonly text: string;
  /** P4: the voice-over starts this long after the scene start (default 0). */
  readonly voiceOffsetMs?: number | undefined;
  /** P4: the clip has an audio stream (used only when clip audio is mixed in). */
  readonly clipHasAudio?: boolean | undefined;
}

/**
 * P4 design S1: configurable layers. Absent: the M6 mix (voice + optional ducked music), with
 * the same filter graph as before.
 */
export interface RenderAudioMix {
  readonly voiceGainDb: number;
  /** Mix each clip's own audio (silence for clips without), at this gain; null: drop it. */
  readonly clipAudio: { readonly gainDb: number } | null;
  readonly musicFadeInMs: number;
  readonly musicFadeOutMs: number;
  readonly musicDucking: boolean;
  /** Scene indexes (0-based) where the music is silent. */
  readonly musicMutedScenes: readonly number[];
  readonly sfx: readonly {
    readonly file: string;
    /** From the start of the render. */
    readonly startMs: number;
    readonly gainDb: number;
  }[];
}

export interface RenderMusicInput {
  readonly file: string;
  /** Base level of the bed under the voice (default −18 dB). */
  readonly volumeDb: number;
}

export interface RenderRequest {
  readonly scenes: readonly RenderSceneInput[];
  readonly music: RenderMusicInput | null;
  /** P4: configurable audio layers (`render.v2`); absent for the M6 mix. */
  readonly audio?: RenderAudioMix | undefined;
  readonly burnInCaptions: boolean;
  /** An empty directory for intermediate and output files. */
  readonly workDir: string;
  readonly spec?: RenderOutputSpec | undefined;
  readonly tools?: MediaTools | undefined;
  readonly fontsDir?: string | undefined;
  /** Ceiling per FFmpeg step. */
  readonly stepTimeoutMs?: number | undefined;
  /** Progress callback (stage names), e.g. for job events. */
  readonly onStage?: ((stage: RenderStage) => void | Promise<void>) | undefined;
}

export type RenderStage = 'normalise' | 'concat' | 'narration' | 'mix' | 'loudness' | 'encode';

export interface LoudnessMeasurement {
  readonly inputIntegrated: number | null;
  readonly inputTruePeak: number | null;
  readonly inputRange: number | null;
}

export interface RenderOutput {
  readonly videoFile: string;
  readonly srtFile: string;
  readonly srt: string;
  readonly cues: readonly CaptionCue[];
  readonly durationMs: number;
  /** Scene start times in the render (ms), in order. */
  readonly sceneStartsMs: readonly number[];
  /** Windows where the last clip frame is held: [startMs, endMs]. */
  readonly heldFrames: readonly (readonly [number, number])[];
  /** Windows where narration is expected: [startMs, endMs]. */
  readonly speechWindows: readonly (readonly [number, number])[];
  readonly loudness: LoudnessMeasurement;
}

export class RenderInputError extends Error {
  override readonly name = 'RenderInputError';
}

/**
 * Paths placed inside filter graphs and the concat list must be plain (FFmpeg filter syntax has no
 * safe quoting): letters, digits, `/ _ . -`, and on Windows a leading drive (`C:`). Windows
 * separators become `/`, which FFmpeg accepts. `pathApi` is injectable for tests.
 */
const SAFE_PATH = /^(?:[A-Za-z]:)?[A-Za-z0-9/_.-]+$/;
export function plainMediaPath(p: string, pathApi: path.PlatformPath = path): string {
  const resolved = pathApi.resolve(p);
  const plain = pathApi.sep === '\\' ? resolved.replaceAll('\\', '/') : resolved;
  if (!SAFE_PATH.test(plain)) {
    throw new RenderInputError(
      `unsafe path for a filter graph: ${resolved} (use a work directory with only letters, digits, / _ . -)`,
    );
  }
  return plain;
}

/** A plain path as a filter option value: the drive colon is escaped for both parsing levels. */
export function filterOptionPath(p: string, pathApi: path.PlatformPath = path): string {
  return plainMediaPath(p, pathApi).replace(/^([A-Za-z]):/, '$1\\\\:');
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Validates the timeline: a voice-over never exceeds its scene (X6 is enforced upstream too). */
export function planTimeline(scenes: readonly RenderSceneInput[]): {
  readonly totalMs: number;
  readonly startsMs: number[];
  readonly heldFrames: [number, number][];
  readonly speechWindows: [number, number][];
} {
  if (scenes.length === 0) throw new RenderInputError('a render needs at least one scene');
  const startsMs: number[] = [];
  const heldFrames: [number, number][] = [];
  const speechWindows: [number, number][] = [];
  let at = 0;
  scenes.forEach((s, i) => {
    if (s.durationMs <= 0) throw new RenderInputError(`scene ${String(i + 1)} has no duration`);
    const offset = s.voiceOffsetMs ?? 0;
    if (offset < 0) throw new RenderInputError(`scene ${String(i + 1)}: negative voice offset`);
    if (s.voiceFile && offset + (s.voiceDurationMs ?? 0) > s.durationMs + 50) {
      throw new RenderInputError(`scene ${String(i + 1)}: the voice-over is longer than the scene`);
    }
    startsMs.push(at);
    if (s.clipDurationMs < s.durationMs)
      heldFrames.push([at + s.clipDurationMs, at + s.durationMs]);
    if (s.voiceFile && s.voiceDurationMs) {
      speechWindows.push([at + offset, at + Math.min(offset + s.voiceDurationMs, s.durationMs)]);
    }
    at += s.durationMs;
  });
  return { totalMs: at, startsMs, heldFrames, speechWindows };
}

export async function renderVideo(request: RenderRequest): Promise<RenderOutput> {
  const tools = request.tools ?? DEFAULT_MEDIA_TOOLS;
  const spec = request.spec ?? DEFAULT_RENDER_SPEC;
  const timeout = request.stepTimeoutMs ?? 600_000;
  // Validated here, before any FFmpeg step; native form for ordinary arguments.
  plainMediaPath(request.workDir);
  const work = path.resolve(request.workDir);
  const fonts = filterOptionPath(request.fontsDir ?? RENDER_FONTS_DIR);
  const ff = (args: string[]) =>
    runTool(
      tools.ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args],
      timeout,
    );
  const timeline = planTimeline(request.scenes);
  const stage = async (s: RenderStage) => {
    await request.onStage?.(s);
  };

  // 1. Every clip to the output spec, exactly the scene's length (last frame held if short).
  await stage('normalise');
  const fit = [
    `scale=${String(spec.width)}:${String(spec.height)}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${String(spec.width)}:${String(spec.height)}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${String(spec.fps)}`,
  ].join(',');
  const segments: string[] = [];
  for (const [i, scene] of request.scenes.entries()) {
    const out = path.join(work, `scene-${String(i)}.mp4`);
    await ff([
      '-i',
      scene.clipFile,
      '-an',
      '-vf',
      `tpad=stop_mode=clone:stop_duration=${sec(scene.durationMs)},${fit}`,
      '-t',
      sec(scene.durationMs),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '--',
      out,
    ]);
    segments.push(out);
  }

  // 2. Hard cuts (X7): identical segments, joined without re-encoding.
  await stage('concat');
  const list = path.join(work, 'scenes.txt');
  await writeFile(list, segments.map((s) => `file '${plainMediaPath(s)}'`).join('\n') + '\n');
  const joined = path.join(work, 'joined.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '--', joined]);

  // 3. Narration: each scene's voice-over from the scene start, silence to the scene end.
  await stage('narration');
  const inputs: string[] = [];
  const parts: string[] = [];
  const fmt = `aresample=${String(spec.sampleRate)},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  let n = 0;
  request.scenes.forEach((s, i) => {
    const d = sec(s.durationMs);
    if (s.voiceFile) {
      inputs.push('-i', s.voiceFile);
      const offset = s.voiceOffsetMs ?? 0;
      const delay = offset > 0 ? `adelay=delays=${String(offset)}:all=1,` : '';
      parts.push(
        `[${String(n)}:a]${fmt},${delay}atrim=duration=${d},apad=whole_dur=${d}[a${String(i)}]`,
      );
      n += 1;
    } else {
      parts.push(
        `anullsrc=r=${String(spec.sampleRate)}:cl=stereo,atrim=duration=${d},aformat=sample_fmts=fltp[a${String(i)}]`,
      );
    }
  });
  const labels = request.scenes.map((_, i) => `[a${String(i)}]`).join('');
  parts.push(`${labels}concat=n=${String(request.scenes.length)}:v=0:a=1[voice]`);
  const narration = path.join(work, 'narration.wav');
  await ff([
    ...inputs,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[voice]',
    '-c:a',
    'pcm_s16le',
    '--',
    narration,
  ]);

  // 4. Music bed ducked under the voice (X5); P4: configurable layers.
  await stage('mix');
  let mix = narration;
  if (request.audio) {
    const clipTrack = request.audio.clipAudio
      ? await clipAudioTrack(ff, request.scenes, work, fmt, spec.sampleRate)
      : null;
    mix = path.join(work, 'mix.wav');
    const graph = mixGraph({
      audio: request.audio,
      music: request.music,
      totalMs: timeline.totalMs,
      sceneStartsMs: timeline.startsMs,
      sceneDurationsMs: request.scenes.map((sc) => sc.durationMs),
      fmt,
      clipTrack: clipTrack !== null,
    });
    await ff([
      '-i',
      narration,
      ...(clipTrack ? ['-i', clipTrack] : []),
      ...(request.music ? ['-i', request.music.file] : []),
      ...request.audio.sfx.flatMap((x) => ['-i', x.file]),
      '-filter_complex',
      graph,
      '-map',
      '[mix]',
      '-c:a',
      'pcm_s16le',
      '--',
      mix,
    ]);
  } else if (request.music) {
    const total = timeline.totalMs;
    const fade = Math.min(1500, total / 2);
    mix = path.join(work, 'mix.wav');
    await ff([
      '-i',
      narration,
      '-i',
      request.music.file,
      '-filter_complex',
      [
        `[1:a]${fmt},aloop=loop=-1:size=2147483647,atrim=duration=${sec(total)},volume=${request.music.volumeDb.toFixed(1)}dB,afade=t=out:st=${sec(total - fade)}:d=${sec(fade)}[bed]`,
        `[0:a]${fmt},asplit=2[voice][key]`,
        '[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]',
        '[voice][ducked]amix=inputs=2:duration=first:normalize=0[mix]',
      ].join(';'),
      '-map',
      '[mix]',
      '-c:a',
      'pcm_s16le',
      '--',
      mix,
    ]);
  }

  // 5. Loudness: measure (pass 1), then normalise linearly in the final encode (pass 2).
  await stage('loudness');
  const target = spec.loudness;
  const base = `I=${String(target.integrated)}:TP=${String(target.truePeak)}:LRA=${String(target.range)}`;
  const measured = await measureLoudness(tools, mix, base, timeout);
  const loudnorm =
    measured.inputIntegrated === null
      ? 'anull' // silent track: nothing to normalise
      : `loudnorm=${base}:measured_I=${String(measured.inputIntegrated)}:measured_TP=${String(measured.inputTruePeak ?? 0)}:measured_LRA=${String(measured.inputRange ?? 0)}:measured_thresh=${String(measured.threshold ?? -70)}:offset=${String(measured.offset ?? 0)}:linear=true`;

  // 6. Captions (X4) and the single final encode.
  await stage('encode');
  const cues = buildCaptionCues(
    request.scenes.map((s, i) => ({
      startMs: (timeline.startsMs[i] ?? 0) + (s.voiceOffsetMs ?? 0),
      text: s.voiceFile ? s.text : '',
      speechMs: Math.min(s.voiceDurationMs ?? 0, s.durationMs - (s.voiceOffsetMs ?? 0)),
    })),
  );
  const srt = toSrt(cues);
  const srtCheck = checkSrt(srt, timeline.totalMs);
  if (srtCheck.issues.length > 0) {
    throw new MediaToolError(`caption file invalid: ${srtCheck.issues.join('; ')}`);
  }
  const srtFile = path.join(work, 'captions.srt');
  await writeFile(srtFile, srt, 'utf8');
  const assFile = path.join(work, 'captions.ass');
  await writeFile(assFile, toAss(cues, DEFAULT_CAPTION_STYLE), 'utf8');
  const video =
    request.burnInCaptions && cues.length > 0
      ? `[0:v]subtitles=filename=${filterOptionPath(assFile)}:fontsdir=${fonts}[v]`
      : '[0:v]null[v]';
  const videoFile = path.join(work, 'render.mp4');
  await ff([
    '-i',
    joined,
    '-i',
    mix,
    '-filter_complex',
    `${video};[1:a]${loudnorm},aresample=${String(spec.sampleRate)}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    spec.preset,
    '-crf',
    String(spec.crf),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(spec.fps),
    '-c:a',
    'aac',
    '-b:a',
    spec.audioBitrate,
    '-ar',
    String(spec.sampleRate),
    '-ac',
    '2',
    '-t',
    sec(timeline.totalMs),
    '-movflags',
    '+faststart',
    '--',
    videoFile,
  ]);
  return {
    videoFile,
    srtFile,
    srt,
    cues,
    durationMs: timeline.totalMs,
    sceneStartsMs: timeline.startsMs,
    heldFrames: timeline.heldFrames,
    speechWindows: timeline.speechWindows,
    loudness: {
      inputIntegrated: measured.inputIntegrated,
      inputTruePeak: measured.inputTruePeak,
      inputRange: measured.inputRange,
    },
  };
}

interface LoudnormPass1 extends LoudnessMeasurement {
  readonly threshold: number | null;
  readonly offset: number | null;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parses the JSON block `loudnorm` prints at the end of pass 1. */
export function parseLoudnormJson(stderr: string): LoudnormPass1 {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new MediaToolError('loudnorm printed no measurement');
  const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  return {
    inputIntegrated: finite(json['input_i']),
    inputTruePeak: finite(json['input_tp']),
    inputRange: finite(json['input_lra']),
    threshold: finite(json['input_thresh']),
    offset: finite(json['target_offset']),
  };
}

async function measureLoudness(
  tools: MediaTools,
  file: string,
  base: string,
  timeoutMs: number,
): Promise<LoudnormPass1> {
  const { stderr } = await runTool(
    tools.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-af',
      `loudnorm=${base}:print_format=json`,
      '-f',
      'null',
      '-',
    ],
    timeoutMs,
  );
  return parseLoudnormJson(stderr);
}

/** Scene 1's keyframe as the 1080×1920 JPEG thumbnail (an approved, human-chosen frame). */
export async function renderThumbnail(options: {
  readonly imageFile: string;
  readonly out: string;
  readonly spec?: RenderOutputSpec | undefined;
  readonly tools?: MediaTools | undefined;
}): Promise<void> {
  const tools = options.tools ?? DEFAULT_MEDIA_TOOLS;
  const spec = options.spec ?? DEFAULT_RENDER_SPEC;
  await runTool(
    tools.ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-i',
      options.imageFile,
      '-vf',
      `scale=${String(spec.width)}:${String(spec.height)}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${String(spec.width)}:${String(spec.height)}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '--',
      options.out,
    ],
    tools.timeoutMs,
  );
}

/** First line of `ffmpeg -version` (recorded per render: deploy 5.1 vs dev 6.1, risk R6). */
export async function ffmpegVersion(tools: MediaTools = DEFAULT_MEDIA_TOOLS): Promise<string> {
  const { stdout } = await runTool(tools.ffmpegPath, ['-version'], tools.timeoutMs);
  return stdout.split('\n')[0]?.trim() ?? 'unknown';
}

/** Each scene's own clip audio, cut to the scene (silence when the clip has none), joined (P4). */
async function clipAudioTrack(
  ff: (args: string[]) => Promise<unknown>,
  scenes: readonly RenderSceneInput[],
  work: string,
  fmt: string,
  sampleRate: number,
): Promise<string> {
  const parts: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    const d = sec(scene.durationMs);
    const out = path.join(work, `clip-audio-${String(i)}.wav`);
    await ff(
      scene.clipHasAudio
        ? [
            '-i',
            scene.clipFile,
            '-vn',
            '-af',
            `${fmt},atrim=duration=${d},apad=whole_dur=${d}`,
            '-t',
            d,
            '-c:a',
            'pcm_s16le',
            '--',
            out,
          ]
        : [
            '-f',
            'lavfi',
            '-i',
            `anullsrc=r=${String(sampleRate)}:cl=stereo`,
            '-t',
            d,
            '-c:a',
            'pcm_s16le',
            '--',
            out,
          ],
    );
    parts.push(out);
  }
  const joined = path.join(work, 'clip-audio.wav');
  await ff([
    ...parts.flatMap((p) => ['-i', p]),
    '-filter_complex',
    `${parts.map((_, i) => `[${String(i)}:a]`).join('')}concat=n=${String(parts.length)}:v=0:a=1[c]`,
    '-map',
    '[c]',
    '-c:a',
    'pcm_s16le',
    '--',
    joined,
  ]);
  return joined;
}

/**
 * The P4 mix graph. Inputs, in order: narration, clip audio (when mixed), music (when set), then
 * each sound effect. The narration is first, so `amix=duration=first` keeps the render's length.
 */
export function mixGraph(options: {
  readonly audio: RenderAudioMix;
  readonly music: RenderMusicInput | null;
  readonly totalMs: number;
  readonly sceneStartsMs: readonly number[];
  readonly sceneDurationsMs: readonly number[];
  readonly fmt: string;
  readonly clipTrack: boolean;
}): string {
  const { audio, music, fmt } = options;
  const db = (v: number) => `${v.toFixed(1)}dB`;
  const parts: string[] = [];
  const tracks: string[] = [];
  let next = 1;
  const duck = music !== null && audio.musicDucking;
  const voiceGain = audio.voiceGainDb !== 0 ? `,volume=${db(audio.voiceGainDb)}` : '';
  parts.push(
    duck ? `[0:a]${fmt}${voiceGain},asplit=2[voice][key]` : `[0:a]${fmt}${voiceGain}[voice]`,
  );
  tracks.push('[voice]');
  if (options.clipTrack && audio.clipAudio) {
    parts.push(`[${String(next)}:a]${fmt},volume=${db(audio.clipAudio.gainDb)}[clip]`);
    tracks.push('[clip]');
    next += 1;
  }
  if (music) {
    const total = options.totalMs;
    const chain = [
      `[${String(next)}:a]${fmt}`,
      'aloop=loop=-1:size=2147483647',
      `atrim=duration=${sec(total)}`,
      `volume=${music.volumeDb.toFixed(1)}dB`,
    ];
    const fadeIn = Math.min(audio.musicFadeInMs, total / 2);
    const fadeOut = Math.min(audio.musicFadeOutMs, total / 2);
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(fadeIn)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${sec(total - fadeOut)}:d=${sec(fadeOut)}`);
    for (const i of audio.musicMutedScenes) {
      const start = options.sceneStartsMs[i];
      const length = options.sceneDurationsMs[i];
      if (start === undefined || length === undefined) continue;
      chain.push(`volume=enable='between(t,${sec(start)},${sec(start + length)})':volume=0`);
    }
    parts.push(`${chain.join(',')}[${duck ? 'bedraw' : 'bed'}]`);
    if (duck)
      parts.push(
        '[bedraw][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bed]',
      );
    tracks.push('[bed]');
    next += 1;
  }
  audio.sfx.forEach((x, k) => {
    parts.push(
      `[${String(next)}:a]${fmt},adelay=delays=${String(x.startMs)}:all=1,volume=${db(x.gainDb)}[sfx${String(k)}]`,
    );
    tracks.push(`[sfx${String(k)}]`);
    next += 1;
  });
  parts.push(
    tracks.length === 1
      ? `${tracks[0] ?? '[voice]'}anull[mix]`
      : `${tracks.join('')}amix=inputs=${String(tracks.length)}:duration=first:normalize=0[mix]`,
  );
  return parts.join(';');
}
