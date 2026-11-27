import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  inspectAudio,
  inspectVideoFile,
  MediaToolsMissingError,
  MediaValidationError,
  parseProbeOutput,
  probeFile,
  sniffContainer,
  synthTone,
  synthVideo,
} from './index.js';

const bytes = (...values: number[]) =>
  new Uint8Array([...values, ...new Array<number>(16).fill(0)]);
const text = (s: string) => [...Buffer.from(s, 'latin1')];

describe('sniffContainer', () => {
  it('recognises containers from magic bytes', () => {
    expect(sniffContainer(bytes(...text('ID3')))).toBe('mp3');
    expect(sniffContainer(bytes(0xff, 0xfb))).toBe('mp3');
    expect(sniffContainer(bytes(0xff, 0xf1))).toBe('adts');
    expect(sniffContainer(bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WAVE')))).toBe('wav');
    expect(sniffContainer(bytes(0, 0, 0, 0x20, ...text('ftypisom')))).toBe('iso');
    expect(sniffContainer(bytes(0, 0, 0, 0x14, ...text('ftypqt  ')))).toBe('quicktime');
    expect(sniffContainer(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('webm');
    expect(sniffContainer(bytes(...text('GIF89a')))).toBeNull();
    expect(sniffContainer(new Uint8Array(4))).toBeNull();
  });
});

describe('parseProbeOutput', () => {
  it('normalizes streams, rates and cover art', () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        format: { format_name: 'mov,mp4', duration: '6.006', bit_rate: '812345' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 720,
            height: 1280,
            avg_frame_rate: '30000/1001',
            duration: '6.006',
          },
          { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
          {
            index: 2,
            codec_type: 'video',
            codec_name: 'mjpeg',
            avg_frame_rate: '0/0',
            disposition: { attached_pic: 1 },
          },
        ],
      }),
    );
    expect(probe.durationMs).toBe(6006);
    expect(probe.bitRate).toBe(812345);
    expect(probe.streams[0]).toMatchObject({
      type: 'video',
      width: 720,
      height: 1280,
      attachedPicture: false,
    });
    expect(probe.streams[0]?.fps).toBeCloseTo(29.97, 2);
    expect(probe.streams[1]).toMatchObject({ type: 'audio', sampleRate: 48000, channels: 2 });
    expect(probe.streams[2]).toMatchObject({ fps: null, attachedPicture: true });
  });
});

// Real FFmpeg/FFprobe (a documented prerequisite, installed in CI).
describe('with FFmpeg', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'acf-media-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('validates a synthetic 9:16 clip', async () => {
    const out = path.join(dir, 'clip.mp4');
    await synthVideo({ out, width: 360, height: 640, durationSec: 2 });
    const video = await inspectVideoFile(out, 'video/mp4', {
      aspectRatio: 9 / 16,
      minDurationMs: 1800,
    });
    expect(video).toMatchObject({
      mimeType: 'video/mp4',
      width: 360,
      height: 640,
      codec: 'h264',
      hasAudio: false,
    });
    expect(video.durationMs).toBeGreaterThanOrEqual(1900);
    expect(video.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts encoder rounding at 480p (480×864 for 9:16) but not a square clip', async () => {
    const rounded = path.join(dir, 'rounded.mp4');
    await synthVideo({ out: rounded, width: 480, height: 864, durationSec: 1 });
    await expect(inspectVideoFile(rounded, null, { aspectRatio: 9 / 16 })).resolves.toMatchObject({
      width: 480,
      height: 864,
    });
    const square = path.join(dir, 'square.mp4');
    await synthVideo({ out: square, width: 480, height: 480, durationSec: 1 });
    await expect(inspectVideoFile(square, null, { aspectRatio: 9 / 16 })).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
    });
  });

  it('rejects a clip with the wrong aspect ratio or too short', async () => {
    const out = path.join(dir, 'wide.mp4');
    await synthVideo({ out, width: 640, height: 360, durationSec: 1 });
    await expect(inspectVideoFile(out, null, { aspectRatio: 9 / 16 })).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
    });
    await expect(inspectVideoFile(out, null, { minDurationMs: 5000 })).rejects.toBeInstanceOf(
      MediaValidationError,
    );
    await expect(inspectVideoFile(out, 'video/webm')).rejects.toMatchObject({
      code: 'MEDIA_TYPE_MISMATCH',
    });
  });

  it('validates MP3 audio and rejects broken or video files', async () => {
    const out = path.join(dir, 'tone.mp3');
    await synthTone({ out, durationSec: 1.5 });
    const audio = await inspectAudio(await readFile(out), 'audio/mpeg');
    expect(audio).toMatchObject({ mimeType: 'audio/mpeg', codec: 'mp3', channels: 1 });
    expect(audio.durationMs).toBeGreaterThan(1300);

    await expect(
      inspectAudio(new TextEncoder().encode('ID3 but not really an mp3 file at all')),
    ).rejects.toMatchObject({ code: 'MEDIA_INVALID' });
    await expect(
      inspectAudio(new TextEncoder().encode('plain text, no audio here')),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    await expect(inspectAudio(await readFile(out), 'audio/wav')).rejects.toMatchObject({
      code: 'MEDIA_TYPE_MISMATCH',
    });
    await expect(inspectAudio(await readFile(out), null, { maxBytes: 100 })).rejects.toMatchObject({
      code: 'MEDIA_TOO_LARGE',
    });

    const clip = path.join(dir, 'clip-for-audio.mp4');
    await synthVideo({ out: clip, width: 360, height: 640, durationSec: 1 });
    await expect(inspectAudio(await readFile(clip))).rejects.toMatchObject({
      code: 'MEDIA_INVALID',
    });
  });

  it('reports a missing binary distinctly', async () => {
    const tools = { ffprobePath: '/nonexistent/ffprobe', ffmpegPath: 'ffmpeg', timeoutMs: 5000 };
    await expect(probeFile(path.join(dir, 'tone.mp3'), tools)).rejects.toBeInstanceOf(
      MediaToolsMissingError,
    );
  });
});
