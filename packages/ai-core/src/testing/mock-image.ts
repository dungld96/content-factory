import { deflateSync } from 'node:zlib';

import type { GenerationContext } from '../capability.js';
import type { ProviderError } from '../errors.js';
import {
  parseImageRequest,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '../media.js';
import type { UsdAmount } from '../money.js';

/** One scripted outcome. Unscripted calls get deterministic solid-colour PNGs. */
export type MockImageStep =
  | {
      readonly kind: 'result';
      /** Raw images to return (e.g. a JPEG, or bytes that are not an image). */
      readonly images?: readonly {
        readonly declaredType: string | null;
        readonly bytes: Uint8Array;
      }[];
      readonly reportedCost?: UsdAmount | null;
    }
  | { readonly kind: 'error'; readonly error: ProviderError };

export interface MockImageCall {
  readonly request: ImageRequest;
  readonly context: GenerationContext;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid solid-colour RGB PNG (deterministic from `seed`). */
export function mockPng(width: number, height: number, seed = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const [r, g, b] = [(seed * 67) % 256, (seed * 131 + 40) % 256, (seed * 29 + 90) % 256];
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Small mock sizes keep tests fast while keeping the requested aspect ratio. */
const MOCK_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  '9:16': [90, 160],
  '1:1': [128, 128],
  '16:9': [160, 90],
};

/**
 * Deterministic {@link ImageProvider} for tests, local development and E2E. No network, validates
 * requests like a real adapter, records every call.
 */
export class MockImageProvider implements ImageProvider {
  readonly providerKey: string;
  readonly capability = 'image_generation' as const;
  private readonly steps: MockImageStep[];
  private readonly recorded: MockImageCall[] = [];
  private counter = 0;

  constructor(options: { providerKey?: string; steps?: readonly MockImageStep[] } = {}) {
    this.providerKey = options.providerKey ?? 'mock';
    this.steps = [...(options.steps ?? [])];
  }

  get calls(): readonly MockImageCall[] {
    return this.recorded;
  }

  /** Appends scripted outcomes (consumed in order, one per call). */
  script(...steps: MockImageStep[]): void {
    this.steps.push(...steps);
  }

  generate(
    input: ImageRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    const request = parseImageRequest(input);
    this.recorded.push({ request, context });
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const step = this.steps.shift();
    if (step?.kind === 'error') return Promise.reject(step.error);
    const [w, h] = MOCK_SIZE[request.aspectRatio] ?? [128, 128];
    const images =
      step?.images ??
      Array.from({ length: request.count }, () => ({
        declaredType: 'image/png',
        bytes: mockPng(w, h, (request.seed ?? 0) + this.counter++),
      }));
    return Promise.resolve({
      images,
      usage: {
        outputImages: images.length,
        inputImages: request.references.length,
        outputPixels: null,
        inputPixels: null,
        outputTokens: null,
        inputTokens: null,
      },
      reportedCost: step?.reportedCost ?? null,
      providerRequestId: `mock-img-${String(this.recorded.length)}`,
      servedModel: request.modelKey,
      latencyMs: 1,
    });
  }
}
