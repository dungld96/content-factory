// M4a: image upload through the API and authenticated streaming reads (M4 design §4.2–§4.3),
// against the real object storage server (SeaweedFS locally and in CI).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AssetDto } from '@acf/contracts';
import { synthTone } from '@acf/media';
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

// M5a: audio upload (FFprobe-validated) and byte-range streaming for playback.
describe('audio upload and byte ranges (M5a)', () => {
  let tone: Uint8Array;
  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acf-audio-test-'));
    const out = path.join(dir, 'tone.mp3');
    await synthTone({ out, durationSec: 1.2 });
    tone = new Uint8Array(await readFile(out));
    await rm(dir, { recursive: true, force: true });
  });
  const uploadAudio = (projectId: string, bytes: Uint8Array, query: string, type = 'audio/mpeg') =>
    ctx.as('editor', 'POST', `/projects/${projectId}/assets/upload?assetType=audio${query}`, {
      rawBody: bytes,
      headers: { 'content-type': type },
    });

  it('stores a voice-over with its measured duration and streams byte ranges', async () => {
    const f = await ctx.fixture();
    const res = await uploadAudio(f.projectId, tone, '&purpose=voiceover&filename=vo.mp3');
    expect(res.status).toBe(201);
    const asset = bodyOf<AssetDto>(res);
    expect(asset).toMatchObject({
      assetType: 'audio',
      sourceType: 'upload',
      mimeType: 'audio/mpeg',
      sizeBytes: tone.byteLength,
      checksumSha256: sha256Hex(tone),
      width: null,
      metadata: { purpose: 'voiceover', audio: { codec: 'mp3', channels: 1 } },
    });
    expect(asset.durationMs).toBeGreaterThan(1000);
    expect(asset.storageKey).toMatch(/\.mp3$/);

    const whole = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.bytes).toEqual(tone);

    const part = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`, {
      headers: { range: 'bytes=10-109' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-109/${String(tone.byteLength)}`);
    expect(part.headers.get('content-length')).toBe('100');
    expect(part.bytes).toEqual(tone.subarray(10, 110));

    const tail = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`, {
      headers: { range: 'bytes=-16' },
    });
    expect([tail.status, tail.bytes]).toEqual([206, tone.subarray(tone.byteLength - 16)]);

    const outside = await ctx.as('viewer', 'GET', `/assets/${asset.id}/content`, {
      headers: { range: `bytes=${String(tone.byteLength)}-` },
    });
    expect([outside.status, codeOf(outside)]).toEqual([416, 'RANGE_NOT_SATISFIABLE']);
    expect(outside.headers.get('content-range')).toBe(`bytes */${String(tone.byteLength)}`);
  });

  it('requires a purpose, a licence note for music, and real audio', async () => {
    const f = await ctx.fixture();
    expect((await uploadAudio(f.projectId, tone, '')).status).toBe(400);
    const noLicense = await uploadAudio(f.projectId, tone, '&purpose=music');
    expect([noLicense.status, codeOf(noLicense)]).toEqual([422, 'LICENSE_NOTE_REQUIRED']);
    const music = await uploadAudio(
      f.projectId,
      tone,
      `&purpose=music&licenseNote=${encodeURIComponent('Own recording, all rights')}`,
    );
    expect(music.status).toBe(201);
    expect(bodyOf<AssetDto>(music)).toMatchObject({
      sourceNote: 'Own recording, all rights',
      metadata: { purpose: 'music' },
    });
    const notAudio = await uploadAudio(f.projectId, png, '&purpose=voiceover', 'image/png');
    expect([notAudio.status, codeOf(notAudio)]).toEqual([415, 'UNSUPPORTED_MEDIA']);
    const broken = await uploadAudio(
      f.projectId,
      new TextEncoder().encode('ID3 this is not decodable audio data'),
      '&purpose=voiceover',
    );
    expect([broken.status, codeOf(broken)]).toEqual([422, 'MEDIA_INVALID']);
    const imageWithPurpose = await upload(f.projectId, png, 'image/png', '&purpose=music');
    expect(imageWithPurpose.status).toBe(400);
  });

  it('answers 503 MEDIA_TOOLS_MISSING without FFprobe', async () => {
    const noTools = await startAuthApp({ FFPROBE_PATH: '/nonexistent/ffprobe' });
    try {
      const as = actAs(noTools.baseUrl, await signInAll(noTools.baseUrl, ctx.ids));
      const f = await ctx.fixture();
      const res = await as(
        'editor',
        'POST',
        `/projects/${f.projectId}/assets/upload?assetType=audio&purpose=voiceover`,
        { rawBody: tone, headers: { 'content-type': 'audio/mpeg' } },
      );
      expect([res.status, codeOf(res)]).toEqual([503, 'MEDIA_TOOLS_MISSING']);
    } finally {
      await noTools.close();
    }
  });
});
