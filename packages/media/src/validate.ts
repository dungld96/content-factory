import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import {
  DEFAULT_MEDIA_TOOLS,
  MediaToolError,
  probeFile,
  withTempFile,
  type MediaTools,
  type ProbedStream,
  type ProbeResult,
} from './probe.js';

/**
 * Audio and video validation (M5 design §6.3, §7.3; CLAUDE.md §8): magic bytes decide the
 * container, the declared type must agree, FFprobe confirms the streams, duration and dimensions.
 * Nothing is re-encoded or upscaled.
 */
export const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac'] as const;
export type AudioMimeType = (typeof AUDIO_MIME_TYPES)[number];
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

export const MEDIA_EXTENSION: Readonly<Record<AudioMimeType | VideoMimeType, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export type MediaIssueCode =
  'UNSUPPORTED_MEDIA' | 'MEDIA_TOO_LARGE' | 'MEDIA_INVALID' | 'MEDIA_TYPE_MISMATCH';

export class MediaValidationError extends Error {
  override readonly name = 'MediaValidationError';
  constructor(
    readonly code: MediaIssueCode,
    message: string,
  ) {
    super(message);
  }
}

const at = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/** Container family from magic bytes. ISO BMFF (`ftyp`) is `iso` until FFprobe sees the streams. */
export type SniffedContainer = 'mp3' | 'wav' | 'adts' | 'iso' | 'quicktime' | 'webm';

export function sniffContainer(bytes: Uint8Array): SniffedContainer | null {
  if (bytes.byteLength < 12) return null;
  if (at(bytes, [0x49, 0x44, 0x33])) return 'mp3'; // "ID3" tag
  if (at(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === 'WAVE') return 'wav';
  if (at(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm'; // EBML
  if (ascii(bytes, 4, 8) === 'ftyp') return ascii(bytes, 8, 10) === 'qt' ? 'quicktime' : 'iso';
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
    // Frame sync: layer bits 00 = AAC ADTS; otherwise an MPEG audio frame (MP3 without ID3).
    return (b1 & 0x06) === 0 ? 'adts' : 'mp3';
  }
  return null;
}

function checkDeclared(
  declared: string | null | undefined,
  actual: string,
  aliases: readonly string[] = [],
) {
  const value = declared?.split(';')[0]?.trim().toLowerCase();
  if (!value || value === 'application/octet-stream') return;
  if (value !== actual && !aliases.includes(value)) {
    throw new MediaValidationError(
      'MEDIA_TYPE_MISMATCH',
      `declared ${value}, content is ${actual}`,
    );
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function probeOrInvalid(file: string, tools: MediaTools): Promise<ProbeResult> {
  try {
    return await probeFile(file, tools);
  } catch (error) {
    if (error instanceof MediaToolError) {
      throw new MediaValidationError('MEDIA_INVALID', 'the file cannot be decoded');
    }
    throw error; // MediaToolsMissingError
  }
}

const realStreams = (probe: ProbeResult, type: ProbedStream['type']) =>
  probe.streams.filter((s) => s.type === type && !s.attachedPicture);

export interface InspectedAudio {
  readonly mimeType: AudioMimeType;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
  readonly durationMs: number;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly bitRate: number | null;
}

export const AUDIO_LIMITS = { maxBytes: 25 * 1024 * 1024, maxDurationMs: 30 * 60 * 1000 } as const;

/**
 * Validates an audio file (MP3, WAV, M4A/AAC). Cover art is allowed; any real video stream is not.
 * @throws {MediaValidationError | MediaToolsMissingError}
 */
export async function inspectAudio(
  bytes: Uint8Array,
  declaredType?: string | null,
  options: { maxBytes?: number; tools?: MediaTools } = {},
): Promise<InspectedAudio> {
  const maxBytes = options.maxBytes ?? AUDIO_LIMITS.maxBytes;
  const tools = options.tools ?? DEFAULT_MEDIA_TOOLS;
  if (bytes.byteLength === 0) throw new MediaValidationError('MEDIA_INVALID', 'the file is empty');
  if (bytes.byteLength > maxBytes) {
    throw new MediaValidationError('MEDIA_TOO_LARGE', `larger than ${String(maxBytes)} bytes`);
  }
  const container = sniffContainer(bytes);
  const mimeType: AudioMimeType | null =
    container === 'mp3'
      ? 'audio/mpeg'
      : container === 'wav'
        ? 'audio/wav'
        : container === 'adts'
          ? 'audio/aac'
          : container === 'iso'
            ? 'audio/mp4'
            : null;
  if (!mimeType) {
    throw new MediaValidationError(
      'UNSUPPORTED_MEDIA',
      'only MP3, WAV and M4A/AAC audio is accepted',
    );
  }
  const aliases: Record<AudioMimeType, readonly string[]> = {
    'audio/mpeg': ['audio/mp3'],
    'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
    'audio/mp4': ['audio/x-m4a', 'audio/m4a', 'audio/aac'],
    'audio/aac': ['audio/x-aac'],
  };
  checkDeclared(declaredType, mimeType, aliases[mimeType]);
  const probe = await withTempFile(bytes, MEDIA_EXTENSION[mimeType], (f) =>
    probeOrInvalid(f, tools),
  );
  const audio = realStreams(probe, 'audio');
  if (audio.length === 0) throw new MediaValidationError('MEDIA_INVALID', 'no audio stream');
  if (realStreams(probe, 'video').length > 0) {
    throw new MediaValidationError(
      'UNSUPPORTED_MEDIA',
      'the file contains video; upload audio only',
    );
  }
  const durationMs = probe.durationMs ?? audio[0]?.durationMs ?? null;
  if (!durationMs || durationMs <= 0) {
    throw new MediaValidationError('MEDIA_INVALID', 'the audio has no duration');
  }
  if (durationMs > AUDIO_LIMITS.maxDurationMs) {
    throw new MediaValidationError('MEDIA_TOO_LARGE', 'longer than 30 minutes');
  }
  const first = audio[0];
  return {
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256Hex: createHash('sha256').update(bytes).digest('hex'),
    durationMs,
    codec: first?.codec ?? null,
    sampleRate: first?.sampleRate ?? null,
    channels: first?.channels ?? null,
    bitRate: probe.bitRate,
  };
}

export const ACCEPTED_VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1'] as const;

/**
 * Relative aspect-ratio tolerance for generated clips. Encoders round sizes to multiples of 16, so a
 * 9:16 clip at 480p arrives as 480×864 (1.2 % off); the render fits each clip into the frame, so
 * that leaves a sliver of padding, not a wrong video. A landscape or square clip stays refused.
 */
export const ASPECT_TOLERANCE = 0.025;

export interface VideoExpectations {
  /** Width/height the clip must match within `ASPECT_TOLERANCE` (e.g. 9/16). */
  readonly aspectRatio?: number;
  /** Minimum duration: shorter clips are rejected (e.g. 90 % of the requested seconds). */
  readonly minDurationMs?: number;
  readonly maxBytes?: number;
}

export interface InspectedVideo {
  readonly mimeType: VideoMimeType;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly codec: string;
  readonly fps: number | null;
  readonly bitRate: number | null;
  readonly hasAudio: boolean;
  readonly audioCodec: string | null;
}

/**
 * Validates a video file on disk (generated clips are streamed to a temp file first).
 * @throws {MediaValidationError | MediaToolsMissingError}
 */
export async function inspectVideoFile(
  file: string,
  declaredType?: string | null,
  expect: VideoExpectations = {},
  tools: MediaTools = DEFAULT_MEDIA_TOOLS,
): Promise<InspectedVideo> {
  const { size } = await stat(file);
  if (size === 0) throw new MediaValidationError('MEDIA_INVALID', 'the file is empty');
  if (expect.maxBytes !== undefined && size > expect.maxBytes) {
    throw new MediaValidationError(
      'MEDIA_TOO_LARGE',
      `larger than ${String(expect.maxBytes)} bytes`,
    );
  }
  const head = new Uint8Array(16);
  const handle = await open(file, 'r');
  try {
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const container = sniffContainer(head);
  const mimeType: VideoMimeType | null =
    container === 'iso'
      ? 'video/mp4'
      : container === 'quicktime'
        ? 'video/quicktime'
        : container === 'webm'
          ? 'video/webm'
          : null;
  if (!mimeType)
    throw new MediaValidationError('UNSUPPORTED_MEDIA', 'not an MP4, MOV or WebM video');
  checkDeclared(declaredType, mimeType, mimeType === 'video/mp4' ? ['application/mp4'] : []);
  const probe = await probeOrInvalid(file, tools);
  const video = realStreams(probe, 'video');
  const first = video[0];
  if (!first || video.length !== 1) {
    throw new MediaValidationError(
      'MEDIA_INVALID',
      `expected one video stream, found ${String(video.length)}`,
    );
  }
  if (!first.codec || !(ACCEPTED_VIDEO_CODECS as readonly string[]).includes(first.codec)) {
    throw new MediaValidationError(
      'UNSUPPORTED_MEDIA',
      `video codec ${first.codec ?? 'unknown'} is not accepted`,
    );
  }
  if (!first.width || !first.height) {
    throw new MediaValidationError('MEDIA_INVALID', 'the video has no dimensions');
  }
  if (expect.aspectRatio !== undefined) {
    const ratio = first.width / first.height;
    if (Math.abs(ratio - expect.aspectRatio) / expect.aspectRatio > ASPECT_TOLERANCE) {
      throw new MediaValidationError(
        'MEDIA_INVALID',
        `${String(first.width)}×${String(first.height)} does not match the requested aspect ratio`,
      );
    }
  }
  const durationMs = probe.durationMs ?? first.durationMs;
  if (!durationMs || durationMs <= 0) {
    throw new MediaValidationError('MEDIA_INVALID', 'the video has no duration');
  }
  if (expect.minDurationMs !== undefined && durationMs < expect.minDurationMs) {
    throw new MediaValidationError(
      'MEDIA_INVALID',
      `${String(durationMs)} ms is shorter than the requested ${String(expect.minDurationMs)} ms`,
    );
  }
  const audio = realStreams(probe, 'audio')[0];
  return {
    mimeType,
    sizeBytes: size,
    sha256Hex: await sha256File(file),
    width: first.width,
    height: first.height,
    durationMs,
    codec: first.codec,
    fps: first.fps,
    bitRate: probe.bitRate,
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec ?? null,
  };
}
