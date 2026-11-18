import { Readable } from 'node:stream';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

import {
  readAll,
  StorageError,
  type ByteRange,
  type ObjectBody,
  type ObjectHead,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from './object-store.js';

export interface S3StoreSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

const status = (error: unknown): number | undefined =>
  error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;

function wrap(error: unknown, action: string): never {
  if (error instanceof StorageError) throw error;
  const name = error instanceof Error ? error.name : 'Error';
  if (name === 'BadDigest' || name === 'XAmzContentSHA256Mismatch') {
    throw new StorageError('CHECKSUM_MISMATCH', `${action}: checksum mismatch`, { cause: error });
  }
  // Never include credentials or the request; the SDK error message is safe to keep short.
  throw new StorageError('STORAGE_UNAVAILABLE', `${action} failed (${name})`, { cause: error });
}

/**
 * S3 implementation (verified against SeaweedFS 4.54 by
 * `packages/storage/test/s3-compat.integration.test.ts`). Works with any S3-compatible server.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(settings: S3StoreSettings, client?: S3Client) {
    this.bucket = settings.bucket;
    this.client =
      client ??
      new S3Client({
        endpoint: settings.endpoint,
        region: settings.region,
        forcePathStyle: settings.forcePathStyle,
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
        },
        // Bounded retries for transient errors; checksums are computed only when we ask.
        maxAttempts: 3,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  async putIfAbsent(key: string, bytes: Uint8Array, options: PutOptions): Promise<PutResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: options.contentType,
          ContentLength: bytes.byteLength,
          ChecksumSHA256: Buffer.from(options.sha256Hex, 'hex').toString('base64'),
          IfNoneMatch: '*',
        }),
      );
      return 'created';
    } catch (error) {
      if (status(error) === 412) return 'exists';
      return wrap(error, 'put');
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (error) {
      if (status(error) === 404) return null;
      return wrap(error, 'head');
    }
  }

  async get(key: string, range?: ByteRange): Promise<ObjectBody | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range
            ? {
                Range: `bytes=${String(range.start)}-${range.end === undefined ? '' : String(range.end)}`,
              }
            : {}),
        }),
      );
      if (!(out.Body instanceof Readable))
        throw new StorageError('STORAGE_UNAVAILABLE', 'get: no body');
      return {
        stream: out.Body,
        sizeBytes: out.ContentLength ?? 0,
        contentType: out.ContentType ?? null,
        contentRange: out.ContentRange ?? null,
      };
    } catch (error) {
      if (status(error) === 404) return null;
      return wrap(error, 'get');
    }
  }

  async getBytes(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const body = await this.get(key);
    if (!body) return null;
    return readAll(body.stream, maxBytes);
  }
}
