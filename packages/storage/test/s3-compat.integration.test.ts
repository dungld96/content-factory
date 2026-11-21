// S3 compatibility of the object storage server (M4 design §4.1; SeaweedFS 4.54 locally and in
// CI). Uses the application key, exactly as the API and worker do.
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { readAll, S3ObjectStore, sha256Hex, type S3StoreSettings } from '../src/index.js';
import { solidPng } from '../src/testing.js';
import { TEST_BUCKET } from './global-setup.js';

function settings(): S3StoreSettings {
  const need = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is not set`);
    return value;
  };
  return {
    endpoint: need('S3_ENDPOINT'),
    region: process.env['S3_REGION'] ?? 'us-east-1',
    bucket: TEST_BUCKET,
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: true,
  };
}

const key = () => `projects/${randomUUID()}/assets/${randomUUID()}/x.png`;

describe('S3 compatibility (application key)', () => {
  const store = new S3ObjectStore(settings());

  it('writes once with a verified checksum, then reports the key as taken', async () => {
    const k = key();
    const bytes = solidPng(9, 16, 1);
    const options = { contentType: 'image/png', sha256Hex: sha256Hex(bytes) };
    expect(await store.putIfAbsent(k, bytes, options)).toBe('created');
    const other = solidPng(9, 16, 2);
    expect(await store.putIfAbsent(k, other, { ...options, sha256Hex: sha256Hex(other) })).toBe(
      'exists',
    );
    expect(await store.getBytes(k, 1_000_000)).toEqual(bytes); // first write kept
  });

  it('rejects bytes that do not match the checksum', async () => {
    const bytes = solidPng(2, 2);
    await expect(
      store.putIfAbsent(key(), bytes, { contentType: 'image/png', sha256Hex: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  it('heads, reads ranges and returns null for missing objects', async () => {
    const k = key();
    const bytes = solidPng(32, 32, 5);
    await store.putIfAbsent(k, bytes, { contentType: 'image/png', sha256Hex: sha256Hex(bytes) });
    expect(await store.head(k)).toEqual({ sizeBytes: bytes.byteLength, contentType: 'image/png' });
    const part = await store.get(k, { start: 0, end: 7 });
    expect(part?.contentRange).toBe(`bytes 0-7/${String(bytes.byteLength)}`);
    if (!part) throw new Error('expected a ranged body');
    expect(await readAll(part.stream, 100)).toEqual(bytes.subarray(0, 8));
    expect(await store.head(`${k}.missing`)).toBeNull();
    expect(await store.get(`${k}.missing`)).toBeNull();
  });

  it('bounds whole-object reads', async () => {
    const k = key();
    const bytes = solidPng(64, 64, 7);
    await store.putIfAbsent(k, bytes, { contentType: 'image/png', sha256Hex: sha256Hex(bytes) });
    await expect(store.getBytes(k, 10)).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' });
  });

  it('documents a server limit: the application key can delete (SeaweedFS simple identities)', async () => {
    // The guarantee therefore lives in the application: ObjectStore has no delete, and writes are
    // conditional. If this ever starts failing with 403, the server enforces it too.
    const k = key();
    const bytes = solidPng(1, 1);
    await store.putIfAbsent(k, bytes, { contentType: 'image/png', sha256Hex: sha256Hex(bytes) });
    const s = settings();
    const raw = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    });
    await raw.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: k }));
    expect(await store.head(k)).toBeNull();
    raw.destroy();
  });

  it('fails clearly when storage is unreachable', async () => {
    const down = new S3ObjectStore({ ...settings(), endpoint: 'http://127.0.0.1:1' });
    await expect(down.head(key())).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
