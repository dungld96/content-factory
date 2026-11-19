import { describe, expect, it } from 'vitest';

import { assetObjectKey, inspectImage, sha256Hex, sniffImageType, uuidv7 } from './index.js';
import { InMemoryObjectStore, solidPng } from './testing.js';

const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('inspectImage', () => {
  it('reads type, dimensions, size and checksum of a PNG', () => {
    const png = solidPng(9, 16, 3);
    expect(inspectImage(png, 'image/png')).toEqual({
      mimeType: 'image/png',
      width: 9,
      height: 16,
      sizeBytes: png.byteLength,
      sha256Hex: sha256Hex(png),
    });
  });

  it('decides the type by magic bytes, not by the declared type', () => {
    expect(sniffImageType(solidPng(1, 1))).toBe('image/png');
    expect(sniffImageType(jpegHeader)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="…"/>'))).toBeNull();
  });

  it.each([
    ['empty', new Uint8Array(), undefined, 'MEDIA_INVALID'],
    ['not an image', new TextEncoder().encode('GIF89a......'), undefined, 'UNSUPPORTED_MEDIA'],
    ['declared type differs', solidPng(2, 2), 'image/webp', 'MEDIA_TYPE_MISMATCH'],
    ['truncated header', solidPng(2, 2).subarray(0, 12), undefined, 'MEDIA_INVALID'],
  ] as const)('rejects %s', (_label, bytes, declared, code) => {
    expect(() => inspectImage(bytes, declared)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects files over the byte limit and images over the pixel limits', () => {
    expect(() => inspectImage(solidPng(4, 4), undefined, { maxBytes: 10 })).toThrow(
      expect.objectContaining({ code: 'MEDIA_TOO_LARGE' }),
    );
    expect(() => inspectImage(solidPng(8193, 1))).toThrow(
      expect.objectContaining({ code: 'MEDIA_TOO_LARGE' }),
    );
  });
});

describe('assetObjectKey', () => {
  it('is content-addressed under the project and asset', () => {
    expect(
      assetObjectKey({
        projectId: 'p',
        assetId: 'a',
        sha256Hex: 'ab'.repeat(32),
        mimeType: 'image/jpeg',
      }),
    ).toBe(`projects/p/assets/a/${'ab'.repeat(32)}.jpg`);
    const key = (mimeType: 'video/mp4' | 'audio/mpeg') =>
      assetObjectKey({ projectId: 'p', assetId: 'a', sha256Hex: 'cd'.repeat(32), mimeType });
    expect(key('video/mp4')).toMatch(/\.mp4$/);
    expect(key('audio/mpeg')).toMatch(/\.mp3$/);
  });
});

describe('InMemoryObjectStore', () => {
  it('is write-once and checks the checksum', async () => {
    const store = new InMemoryObjectStore();
    const bytes = solidPng(2, 2);
    const opts = { contentType: 'image/png', sha256Hex: sha256Hex(bytes) };
    expect(await store.putIfAbsent('k', bytes, opts)).toBe('created');
    expect(
      await store.putIfAbsent('k', solidPng(3, 3), {
        ...opts,
        sha256Hex: sha256Hex(solidPng(3, 3)),
      }),
    ).toBe('exists');
    expect(await store.getBytes('k', 1_000_000)).toEqual(bytes);
    await expect(
      store.putIfAbsent('x', bytes, { ...opts, sha256Hex: '0'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    });
    expect(await store.head('missing')).toBeNull();
  });
});

describe('uuidv7', () => {
  it('encodes the timestamp and the version/variant bits', () => {
    const id = uuidv7(Date.UTC(2026, 10, 18));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 18));
    expect(uuidv7()).not.toBe(uuidv7());
  });
});
