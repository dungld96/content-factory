import { deflateSync } from 'node:zlib';

import {
  readAll,
  streamOf,
  type ByteRange,
  type ObjectBody,
  type ObjectHead,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from './object-store.js';
import { sha256Hex } from './image.js';
import { StorageError } from './object-store.js';

/** In-memory object store for unit tests: same write-once and checksum rules as S3. */
export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** Set to make every call fail as if storage were down. */
  unavailable = false;

  private check(): void {
    if (this.unavailable) throw new StorageError('STORAGE_UNAVAILABLE', 'storage is down (fake)');
  }

  putIfAbsent(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult> {
    this.check();
    if (sha256Hex(bytes) !== options.sha256Hex) {
      return Promise.reject(new StorageError('CHECKSUM_MISMATCH', 'put: checksum mismatch'));
    }
    if (this.objects.has(key)) return Promise.resolve('exists');
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.contentType });
    return Promise.resolve('created');
  }

  head(key: string): Promise<ObjectHead | null> {
    this.check();
    const o = this.objects.get(key);
    return Promise.resolve(
      o ? { sizeBytes: o.bytes.byteLength, contentType: o.contentType } : null,
    );
  }

  get(key: string, range?: ByteRange): Promise<ObjectBody | null> {
    this.check();
    const o = this.objects.get(key);
    if (!o) return Promise.resolve(null);
    const total = o.bytes.byteLength;
    const end = range ? Math.min(range.end ?? total - 1, total - 1) : total - 1;
    const start = range?.start ?? 0;
    const slice = o.bytes.subarray(start, end + 1);
    return Promise.resolve({
      stream: streamOf(slice),
      sizeBytes: slice.byteLength,
      contentType: o.contentType,
      contentRange: range ? `bytes ${String(start)}-${String(end)}/${String(total)}` : null,
    });
  }

  async getBytes(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const body = await this.get(key);
    return body ? readAll(body.stream, maxBytes) : null;
  }
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

/**
 * A valid, solid-colour RGB PNG of the given size (deterministic from `seed`). Used by tests and
 * by the mock image provider; no image library needed.
 */
export function solidPng(width: number, height: number, seed = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
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
