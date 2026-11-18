import { Readable } from 'node:stream';

/**
 * Object storage for asset bytes (M4 design §4.1, ADR-0006). Objects are write-once and
 * content-addressed; there is deliberately no delete or overwrite operation in the application
 * (SeaweedFS's simple identities cannot deny delete, so the guarantee lives in this interface
 * and in conditional writes).
 */
export interface PutOptions {
  readonly contentType: string;
  /** Lowercase hex SHA-256 of the bytes; the server verifies it (S3 `x-amz-checksum-sha256`). */
  readonly sha256Hex: string;
}

/** `created`: the object was written. `exists`: the key was already taken (bytes untouched). */
export type PutResult = 'created' | 'exists';

export interface ObjectHead {
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface ObjectBody extends ObjectHead {
  readonly stream: Readable;
  /** Set for ranged reads: `bytes start-end/total`. */
  readonly contentRange: string | null;
}

export interface ByteRange {
  readonly start: number;
  /** Inclusive; omitted = to the end. */
  readonly end?: number;
}

export interface ObjectStore {
  /** Writes only if the key is free (`If-None-Match: *`), with a server-verified checksum. */
  putIfAbsent(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult>;
  /** `null` when the object does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** `null` when the object does not exist. */
  get(key: string, range?: ByteRange): Promise<ObjectBody | null>;
  /** Reads a whole object into memory (bounded by `maxBytes`). */
  getBytes(key: string, maxBytes: number): Promise<Uint8Array | null>;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(
    readonly code: 'STORAGE_UNAVAILABLE' | 'CHECKSUM_MISMATCH' | 'OBJECT_TOO_LARGE',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Collects a stream into one buffer, failing once it exceeds `maxBytes`. */
export async function readAll(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new StorageError('OBJECT_TOO_LARGE', `object exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function streamOf(bytes: Uint8Array): Readable {
  return Readable.from([Buffer.from(bytes)]);
}

/**
 * A UUIDv7 (RFC 9562): the same ID format Prisma generates (`uuid(7)`), needed before insert
 * because asset object keys contain the asset ID.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
