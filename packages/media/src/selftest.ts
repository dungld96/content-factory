import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_MEDIA_TOOLS, type MediaTools } from './probe.js';
import { inspectRender, type QcReport } from './qc.js';
import { DEFAULT_RENDER_SPEC, ffmpegVersion, renderVideo } from './render.js';
import { synthTone, synthVideo } from './synth.js';

export interface RenderSelfTest {
  readonly ffmpeg: string;
  readonly elapsedMs: number;
  readonly report: QcReport;
  /** P4: a second render with audio layers (offset voice, clip audio, faded music, an effect). */
  readonly layered: QcReport;
}

/**
 * Renders a short synthetic video with every M6 feature (mixed inputs, held frame, narration,
 * ducked music, loudness, burned-in Vietnamese captions) and checks it (M6 risk R6: run it in the
 * deploy image, whose FFmpeg differs from development). No network, no cost.
 */
export async function runRenderSelfTest(
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
): Promise<RenderSelfTest> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acf-render-selftest-'));
  try {
    const file = (name: string) => path.join(dir, name);
    await synthVideo({ out: file('a.mp4'), width: 720, height: 1280, durationSec: 4, tools });
    await synthVideo({
      out: file('b.mp4'),
      width: 1080,
      height: 1920,
      durationSec: 2,
      color: '0x2b8a3e',
      tools,
    });
    await synthTone({ out: file('voice.mp3'), durationSec: 3, tools });
    await synthTone({ out: file('music.mp3'), durationSec: 2, frequency: 220, tools });
    const started = Date.now();
    const out = await renderVideo({
      workDir: dir,
      burnInCaptions: true,
      music: { file: file('music.mp3'), volumeDb: -18 },
      tools,
      scenes: [
        {
          durationMs: 4000,
          clipFile: file('a.mp4'),
          clipDurationMs: 4000,
          voiceFile: file('voice.mp3'),
          voiceDurationMs: 3000,
          text: 'Năm món đồ nhỏ giúp bàn làm việc gọn gàng hơn.',
        },
        {
          durationMs: 2200,
          clipFile: file('b.mp4'),
          clipDurationMs: 2000,
          voiceFile: null,
          voiceDurationMs: null,
          text: '',
        },
      ],
    });
    const report = await inspectRender(
      out.videoFile,
      {
        spec: DEFAULT_RENDER_SPEC,
        durationMs: out.durationMs,
        sceneStartsMs: out.sceneStartsMs,
        heldFrames: out.heldFrames,
        speechWindows: out.speechWindows,
      },
      tools,
    );
    // P4 (render.v2 filters: adelay all=1, volume enable, afade in, amix of several layers).
    await synthTone({ out: file('fx.mp3'), durationSec: 0.5, frequency: 880, tools });
    const layeredDir = path.join(dir, 'layered');
    await mkdir(layeredDir);
    const layeredOut = await renderVideo({
      workDir: layeredDir,
      burnInCaptions: false,
      music: { file: file('music.mp3'), volumeDb: -18 },
      tools,
      audio: {
        voiceGainDb: 0,
        clipAudio: { gainDb: -6 },
        musicFadeInMs: 500,
        musicFadeOutMs: 1500,
        musicDucking: true,
        musicMutedScenes: [1],
        sfx: [{ file: file('fx.mp3'), startMs: 4500, gainDb: 0 }],
      },
      scenes: [
        {
          durationMs: 4000,
          clipFile: file('a.mp4'),
          clipDurationMs: 4000,
          voiceFile: file('voice.mp3'),
          voiceDurationMs: 3000,
          voiceOffsetMs: 500,
          clipHasAudio: false,
          text: 'Năm món đồ nhỏ giúp bàn làm việc gọn gàng hơn.',
        },
        {
          durationMs: 2200,
          clipFile: file('b.mp4'),
          clipDurationMs: 2000,
          voiceFile: null,
          voiceDurationMs: null,
          clipHasAudio: false,
          text: '',
        },
      ],
    });
    const layered = await inspectRender(
      layeredOut.videoFile,
      {
        spec: DEFAULT_RENDER_SPEC,
        durationMs: layeredOut.durationMs,
        sceneStartsMs: layeredOut.sceneStartsMs,
        heldFrames: layeredOut.heldFrames,
        speechWindows: layeredOut.speechWindows,
      },
      tools,
    );
    return {
      ffmpeg: await ffmpegVersion(tools),
      elapsedMs: Date.now() - started,
      report,
      layered,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
