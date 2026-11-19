import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TtsRequest, VideoRequest } from '@acf/ai-core';
import { DEFAULT_MEDIA_TOOLS, synthTone, synthVideo, type MediaTools } from '@acf/media';

/**
 * Renderers for the mock video and TTS providers (tests and E2E only): real, decodable MP4 and
 * MP3 files made with FFmpeg, so validation, storage and playback run as in production.
 */

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acf-mock-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What the mock video provider asks to render (structurally its `ClipSpec`). */
export interface MockClipSpec {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly firstFrame: VideoRequest['firstFrame'];
}

/** A clip of the requested length showing the first frame (or a solid colour). */
export function clipRenderer(tools: MediaTools = DEFAULT_MEDIA_TOOLS) {
  return (spec: MockClipSpec): Promise<Uint8Array> =>
    inTempDir(async (dir) => {
      const out = path.join(dir, 'clip.mp4');
      let imageFile: string | undefined;
      if (spec.firstFrame) {
        imageFile = path.join(dir, 'frame.img');
        await writeFile(imageFile, spec.firstFrame.bytes);
      }
      await synthVideo({
        out,
        width: spec.width,
        height: spec.height,
        durationSec: spec.durationSeconds,
        ...(imageFile ? { imageFile } : {}),
        tools,
      });
      return new Uint8Array(await readFile(out));
    });
}

/** Speech stand-in: a tone lasting about as long as reading the text aloud (15 chars/s). */
export function audioRenderer(tools: MediaTools = DEFAULT_MEDIA_TOOLS) {
  return (request: TtsRequest): Promise<Uint8Array> =>
    inTempDir(async (dir) => {
      const out = path.join(dir, 'speech.mp3');
      const durationSec = Math.min(60, Math.max(1, Math.round(request.text.length / 15)));
      await synthTone({ out, durationSec, tools });
      return new Uint8Array(await readFile(out));
    });
}
