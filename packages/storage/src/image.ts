import { createHash } from 'node:crypto';

import { imageSize } from 'image-size';

/**
 * Image validation for uploads and generated images (M4 design §4.3, decision G8): magic bytes
 * decide the type, the declared type must agree, dimensions are read from the header, and the
 * checksum is computed here. No re-encoding, no upscaling (CLAUDE.md §8).
 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export const IMAGE_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxSide: 8192,
  maxPixels: 40_000_000,
} as const;

export interface InspectedImage {
  readonly mimeType: ImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
}

export type ImageIssueCode =
  'UNSUPPORTED_MEDIA' | 'MEDIA_TOO_LARGE' | 'MEDIA_INVALID' | 'MEDIA_TYPE_MISMATCH';

export class ImageValidationError extends Error {
  override readonly name = 'ImageValidationError';
  constructor(
    readonly code: ImageIssueCode,
    message: string,
  ) {
    super(message);
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);

/** The image type from its magic bytes, or `null` for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Validates an image. `declaredType` (an upload's `Content-Type` or a provider's `media_type`)
 * must match the detected type when given.
 * @throws {ImageValidationError}
 */
export function inspectImage(
  bytes: Uint8Array,
  declaredType?: string | null,
  limits: { maxBytes: number } = IMAGE_LIMITS,
): InspectedImage {
  if (bytes.byteLength === 0) throw new ImageValidationError('MEDIA_INVALID', 'the file is empty');
  if (bytes.byteLength > limits.maxBytes) {
    throw new ImageValidationError(
      'MEDIA_TOO_LARGE',
      `larger than ${String(limits.maxBytes)} bytes`,
    );
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    throw new ImageValidationError(
      'UNSUPPORTED_MEDIA',
      'only PNG, JPEG and WebP images are accepted',
    );
  }
  const declared = declaredType?.split(';')[0]?.trim().toLowerCase();
  if (
    declared &&
    declared !== mimeType &&
    !(declared === 'image/jpg' && mimeType === 'image/jpeg')
  ) {
    throw new ImageValidationError(
      'MEDIA_TYPE_MISMATCH',
      `declared ${declared}, content is ${mimeType}`,
    );
  }
  let width: number | undefined;
  let height: number | undefined;
  try {
    const size = imageSize(bytes);
    width = size.width;
    height = size.height;
  } catch {
    throw new ImageValidationError('MEDIA_INVALID', 'the image header cannot be read');
  }
  if (!width || !height) {
    throw new ImageValidationError('MEDIA_INVALID', 'the image has no dimensions');
  }
  if (
    width > IMAGE_LIMITS.maxSide ||
    height > IMAGE_LIMITS.maxSide ||
    width * height > IMAGE_LIMITS.maxPixels
  ) {
    throw new ImageValidationError(
      'MEDIA_TOO_LARGE',
      `${String(width)}×${String(height)} exceeds the pixel limits`,
    );
  }
  return { mimeType, width, height, sizeBytes: bytes.byteLength, sha256Hex: sha256Hex(bytes) };
}

/** File extensions of the media types the platform stores (images M4; audio and video M5; SRT M6). */
const EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  // M6: render captions.
  'application/x-subrip': 'srt',
} as const;
export type StoredMimeType = keyof typeof EXTENSION;

/**
 * Immutable, content-addressed key (M4 design §4.1):
 * `projects/{projectId}/assets/{assetId}/{sha256}.{ext}`.
 */
export function assetObjectKey(input: {
  readonly projectId: string;
  readonly assetId: string;
  readonly sha256Hex: string;
  readonly mimeType: StoredMimeType;
}): string {
  return `projects/${input.projectId}/assets/${input.assetId}/${input.sha256Hex}.${EXTENSION[input.mimeType]}`;
}
