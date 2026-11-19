// The render pipeline with the real FFmpeg (installed locally and in CI): mixed inputs, held
// frames, narration, music, loudness, captions and their font. No network.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_MEDIA_TOOLS, probeFile, runTool } from './probe.js';
import {
  DEFAULT_RENDER_SPEC,
  planTimeline,
  RENDER_FONTS_DIR,
  RenderInputError,
  renderThumbnail,
  renderVideo,
  type RenderSceneInput,
} from './render.js';
import { runRenderSelfTest } from './selftest.js';
import { synthTone, synthVideo } from './synth.js';

let dir: string;
const file = (name: string) => path.join(dir, name);
const fresh = () => mkdtemp(path.join(dir, 'job-'));

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'acf-render-test-'));
  await synthVideo({ out: file('720.mp4'), width: 720, height: 1280, durationSec: 3 });
  await synthVideo({
    out: file('square.mp4'),
    width: 480,
    height: 480,
    durationSec: 2,
    color: '0x2b8a3e',
  });
  await synthTone({ out: file('voice.mp3'), durationSec: 2 });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const scenes = (): RenderSceneInput[] => [
  {
    durationMs: 3000,
    clipFile: file('720.mp4'),
    clipDurationMs: 3000,
    voiceFile: file('voice.mp3'),
    voiceDurationMs: 2000,
    text: 'Năm món đồ nhỏ giúp bàn làm việc gọn gàng hơn.',
  },
  // Square source (padded) and 200 ms shorter than the scene (last frame held).
  {
    durationMs: 2200,
    clipFile: file('square.mp4'),
    clipDurationMs: 2000,
    voiceFile: null,
    voiceDurationMs: null,
    text: '',
  },
];

describe('planTimeline', () => {
  it('places scenes back to back with held frames and speech windows', () => {
    expect(planTimeline(scenes())).toEqual({
      totalMs: 5200,
      startsMs: [0, 3000],
      heldFrames: [[5000, 5200]],
      speechWindows: [[0, 2000]],
    });
  });

  it('refuses a voice-over longer than its scene (X6) and an empty timeline', () => {
    const [first] = scenes();
    if (!first) throw new Error('fixture');
    expect(() => planTimeline([{ ...first, voiceDurationMs: 3500 }])).toThrow(RenderInputError);
    expect(() => planTimeline([])).toThrow(RenderInputError);
  });
});

describe('renderVideo', () => {
  it('normalises mixed inputs to 1080×1920 H.264/AAC of the exact length at −14 LUFS', async () => {
    const work = await fresh();
    const stages: string[] = [];
    const out = await renderVideo({
      workDir: work,
      scenes: scenes(),
      music: null,
      burnInCaptions: true,
      onStage: (s) => {
        stages.push(s);
      },
    });
    expect(stages).toEqual(['normalise', 'concat', 'narration', 'mix', 'loudness', 'encode']);
    const probe = await probeFile(out.videoFile);
    const video = probe.streams.find((s) => s.type === 'video');
    const audio = probe.streams.find((s) => s.type === 'audio');
    expect(video).toMatchObject({ codec: 'h264', width: 1080, height: 1920, fps: 30 });
    expect(audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(Math.abs((probe.durationMs ?? 0) - 5200)).toBeLessThanOrEqual(100);
    expect(out.srt).toContain('00:00:00,000 --> 00:00:02,000');
    expect(await readFile(out.srtFile, 'utf8')).toBe(out.srt);
    // faststart: the index (moov) precedes the media data.
    const head = (await readFile(out.videoFile)).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(
      head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'),
    );
  }, 180_000);

  it('ducks a looped music bed under the voice and still meets the loudness target', async () => {
    await synthTone({ out: file('music.mp3'), durationSec: 1, frequency: 220 });
    const out = await renderVideo({
      workDir: await fresh(),
      scenes: scenes(),
      music: { file: file('music.mp3'), volumeDb: -18 },
      burnInCaptions: false,
    });
    const { stderr } = await runTool(
      DEFAULT_MEDIA_TOOLS.ffmpegPath,
      ['-hide_banner', '-nostdin', '-i', out.videoFile, '-af', 'ebur128', '-f', 'null', '-'],
      60_000,
    );
    const integrated = Number(
      /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary:')))?.[1],
    );
    expect(Math.abs(integrated - DEFAULT_RENDER_SPEC.loudness.integrated)).toBeLessThanOrEqual(1);
    // The 1 s bed was looped: the scene without narration is not silent.
    const { stderr: silence } = await runTool(
      DEFAULT_MEDIA_TOOLS.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-ss',
        '3.2',
        '-i',
        out.videoFile,
        '-af',
        'silencedetect=n=-50dB:d=1',
        '-f',
        'null',
        '-',
      ],
      60_000,
    );
    expect(silence).not.toContain('silence_start');
  }, 180_000);

  it('burns captions with the bundled Vietnamese font, never a fallback', async () => {
    const work = await fresh();
    const out = await renderVideo({
      workDir: work,
      scenes: scenes(),
      music: null,
      burnInCaptions: true,
    });
    // libass reports which font file it selected; re-run the filter verbosely on the ASS file.
    const { stderr } = await runTool(
      DEFAULT_MEDIA_TOOLS.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'verbose',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=1080x1920:d=1',
        '-vf',
        `subtitles=filename=${path.join(work, 'captions.ass')}:fontsdir=${RENDER_FONTS_DIR}`,
        '-f',
        'null',
        '-',
      ],
      60_000,
    );
    expect(stderr).toMatch(
      /fontselect: \(Be Vietnam Pro SemiBold, [^)]*\) -> BeVietnamPro-SemiBold,/,
    );
    expect(stderr).not.toContain('Error opening');
    // The burned frame differs from the uncaptioned one in the caption band.
    const band = async (video: string) => {
      const { stdout } = await runTool(
        DEFAULT_MEDIA_TOOLS.ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-ss',
          '1',
          '-i',
          video,
          '-vf',
          'crop=1080:220:0:1250,scale=54:11',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-',
        ],
        60_000,
      );
      return stdout;
    };
    const plain = await renderVideo({
      workDir: await fresh(),
      scenes: scenes(),
      music: null,
      burnInCaptions: false,
    });
    expect(await band(out.videoFile)).not.toBe(await band(plain.videoFile));
  }, 240_000);

  it('rejects work paths that cannot be placed safely in a filter graph', async () => {
    await expect(
      renderVideo({
        workDir: path.join(dir, "it's:bad"),
        scenes: scenes(),
        music: null,
        burnInCaptions: true,
      }),
    ).rejects.toThrow(RenderInputError);
  });
});

describe('renderThumbnail', () => {
  it('fits the keyframe into 1080×1920', async () => {
    await synthVideo({ out: file('frame.mp4'), width: 400, height: 400, durationSec: 1 });
    await runTool(
      DEFAULT_MEDIA_TOOLS.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        file('frame.mp4'),
        '-frames:v',
        '1',
        '--',
        file('key.png'),
      ],
      60_000,
    );
    await renderThumbnail({ imageFile: file('key.png'), out: file('thumb.jpg') });
    const probe = await probeFile(file('thumb.jpg'));
    expect(probe.streams[0]).toMatchObject({ width: 1080, height: 1920 });
  }, 60_000);
});

describe('runRenderSelfTest', () => {
  it('passes with the local FFmpeg', async () => {
    const result = await runRenderSelfTest();
    expect(result.report.passed).toBe(true);
    expect(result.ffmpeg).toMatch(/^ffmpeg version/);
  }, 240_000);
});
