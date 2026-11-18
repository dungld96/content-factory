// M4a: image upload through the API and authenticated streaming reads (M4 design §4.2–§4.3),
// against the real object storage server (SeaweedFS locally and in CI).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AssetDto } from '@acf/contracts';
import { sha256Hex } from '@acf/storage';
import { solidPng } from '@acf/storage/testing';

import { startAuthApp } from '../support/auth-app.js';
import { actAs, signInAll } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const png = solidPng(90, 160, 7);
const upload = (projectId: string, bytes: Uint8Array, contentType = 'image/png', query = '') =>
  ctx.as('editor', 'POST', `/projects/${projectId}/assets/upload?assetType=reference${query}`, {
    rawBody: bytes,
    headers: { 'content-type': contentType },
  });

describe('POST /projects/:projectId/assets/upload', () => {
  it('stores the image and registers it with server-computed metadata', async () => {
    const f = await ctx.fixture();
    const res = await upload(f.projectId, png, 'image/png', '&filename=front.png&label=Front');
    expect(res.status).toBe(201);
    const asset = bodyOf<AssetDto>(res);
    expect(asset).toMatchObject({
      assetType: 'reference',
      sourceType: 'upload',
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      checksumSha256: sha256Hex(png),
      width: 90,
      height: 160,
      originalFilename: 'front.png',
      label: 'Front',
      approvalStatus: 'pending',
    });
    expect(asset.storageKey).toBe(
      `projects/${f.projectId}/assets/${asset.id}/${sha256Hex(png)}.png`,
    );

    const content = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('etag')).toBe(`"${sha256Hex(png)}"`);
    expect(content.bytes).toEqual(png);

    const cached = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`, {
      headers: { 'if-none-match': `"${sha256Hex(png)}"` },
    });
    expect(cached.status).toBe(304);
  });

  it('decides the type from the bytes and rejects bad files', async () => {
    const f = await ctx.fixture();
    const notImage = new TextEncoder().encode('GIF89a not supported');
    const unsupported = await upload(f.projectId, notImage, 'image/png');
    expect([unsupported.status, codeOf(unsupported)]).toEqual([415, 'UNSUPPORTED_MEDIA']);
    const mismatch = await upload(f.projectId, png, 'image/webp');
    expect([mismatch.status, codeOf(mismatch)]).toEqual([415, 'MEDIA_TYPE_MISMATCH']);
    const truncated = await upload(f.projectId, png.subarray(0, 20), 'image/png');
    expect([truncated.status, codeOf(truncated)]).toEqual([422, 'MEDIA_INVALID']);
    const empty = await upload(f.projectId, new Uint8Array(), 'image/png');
    expect([empty.status, codeOf(empty)]).toEqual([422, 'MEDIA_INVALID']);
  });

  it('refuses files above the upload limit with 413', async () => {
    const small = await startAuthApp({ UPLOAD_MAX_IMAGE_BYTES: '2048' });
    try {
      const as = actAs(small.baseUrl, await signInAll(small.baseUrl, ctx.ids));
      const f = await ctx.fixture();
      // A valid PNG followed by padding: the size check runs before any decoding.
      const big = new Uint8Array(Buffer.concat([Buffer.from(solidPng(4, 4)), Buffer.alloc(4096)]));
      expect(big.byteLength).toBeGreaterThan(2048);
      const res = await as(
        'editor',
        'POST',
        `/projects/${f.projectId}/assets/upload?assetType=image`,
        {
          rawBody: big,
          headers: { 'content-type': 'image/png' },
        },
      );
      expect([res.status, codeOf(res)]).toEqual([413, 'MEDIA_TOO_LARGE']);
    } finally {
      await small.close();
    }
  });

  it('checks the query and the content item', async () => {
    const f = await ctx.fixture();
    const other = await ctx.fixture();
    const bad = await ctx.as(
      'editor',
      'POST',
      `/projects/${f.projectId}/assets/upload?assetType=video`,
      {
        rawBody: png,
        headers: { 'content-type': 'image/png' },
      },
    );
    expect(bad.status).toBe(400);
    const foreign = await upload(
      f.projectId,
      png,
      'image/png',
      `&contentItemId=${other.contentId}`,
    );
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'REFERENCE_NOT_FOUND']);
  });

  it('answers 503 STORAGE_NOT_CONFIGURED without storage, and 404 for metadata-only assets', async () => {
    const bare = await startAuthApp({
      S3_ENDPOINT: '',
      S3_BUCKET: '',
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
    });
    try {
      const as = actAs(bare.baseUrl, await signInAll(bare.baseUrl, ctx.ids));
      const f = await ctx.fixture();
      const res = await as(
        'editor',
        'POST',
        `/projects/${f.projectId}/assets/upload?assetType=reference`,
        {
          rawBody: png,
          headers: { 'content-type': 'image/png' },
        },
      );
      expect([res.status, codeOf(res)]).toEqual([503, 'STORAGE_NOT_CONFIGURED']);
    } finally {
      await bare.close();
    }
    // The fixture's reference asset was registered in M1 style (metadata only, no bytes).
    const f = await ctx.fixture();
    const missing = await ctx.as('viewer', 'GET', `/assets/${f.assetId}/content`);
    expect([missing.status, codeOf(missing)]).toEqual([404, 'ASSET_CONTENT_MISSING']);
  });
});
