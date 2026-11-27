// Asset metadata, lineage, usages and archive rules (design package §4.2, §4.3, §7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AssetDto,
  AssetInputListDto,
  AssetUsageDto,
  AssetUsagesDto,
  LineageResponse,
  Page,
} from '@acf/contracts';

import { newAsset } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const register = (projectId: string, extra: Record<string, unknown> = {}) =>
  ctx.as('editor', 'POST', `/projects/${projectId}/assets`, { body: newAsset(projectId, extra) });

describe('registration', () => {
  it('registers metadata with an ETag', async () => {
    const f = await ctx.fixture();
    const res = await register(f.projectId, { label: 'front', metadata: { pose: 'front' } });
    expect(res.status).toBe(201);
    expect(bodyOf<AssetDto>(res)).toMatchObject({
      assetType: 'reference',
      sourceType: 'upload',
      sizeBytes: 123_456,
      width: 1080,
      height: 1920,
      label: 'front',
      metadata: { pose: 'front' },
      approvalStatus: 'pending',
      archivedAt: null,
    });
    expect(res.headers.get('etag')).toMatch(/^W\/"\d+"$/);
  });

  it.each([
    [
      'a storage key outside the project',
      (p: string) => ({ storageKey: `projects/other/${p}.png` }),
    ],
    ['a path traversal segment', (p: string) => ({ storageKey: `projects/${p}/../x.png` })],
    ['a MIME type that does not match the asset type', () => ({ mimeType: 'video/mp4' })],
    ['a derived asset without a source', () => ({ sourceType: 'derived' })],
    ['a generated asset (M4 only)', () => ({ sourceType: 'generated' })],
    ['an invalid checksum', () => ({ checksumSha256: 'ABC' })],
    ['a size over 10 GiB', () => ({ sizeBytes: 11 * 1024 ** 3 })],
  ])('rejects %s with 400', async (_name, extra) => {
    const f = await ctx.fixture();
    const res = await register(f.projectId, extra(f.projectId));
    expect([res.status, codeOf(res)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('rejects a duplicate storage key and a foreign source', async () => {
    const f = await ctx.fixture();
    const body = newAsset(f.projectId);
    expect(
      (await ctx.as('editor', 'POST', `/projects/${f.projectId}/assets`, { body })).status,
    ).toBe(201);
    const dup = await ctx.as('editor', 'POST', `/projects/${f.projectId}/assets`, {
      body: { ...body, checksumSha256: 'f'.repeat(64) },
    });
    expect([dup.status, codeOf(dup)]).toEqual([409, 'STORAGE_KEY_TAKEN']);

    const other = await ctx.fixture();
    const foreign = await register(f.projectId, {
      sourceType: 'derived',
      sourceAssetId: other.assetId,
    });
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'REFERENCE_NOT_FOUND']);
  });

  it('only label and metadata are editable', async () => {
    const f = await ctx.fixture();
    const ok = await ctx.as('editor', 'PATCH', `/assets/${f.assetId}`, {
      body: { label: 'front view' },
    });
    expect(bodyOf<AssetDto>(ok).label).toBe('front view');
    const identity = await ctx.as('editor', 'PATCH', `/assets/${f.assetId}`, {
      body: { storageKey: 'projects/x/y.png' },
    });
    expect(identity.status).toBe(400);
  });

  it('refuses the metadata keys the platform writes and keeps their stored values (P2a A2)', async () => {
    const f = await ctx.fixture();
    const reserved = await register(f.projectId, { metadata: { purpose: 'music', note: 'x' } });
    expect([reserved.status, codeOf(reserved)]).toEqual([422, 'METADATA_KEY_RESERVED']);

    // A voice-over upload as the platform writes it (reserved keys set at insert).
    const created = await ctx.prisma.asset.create({
      data: {
        projectId: f.projectId,
        assetType: 'audio',
        sourceType: 'upload',
        storageKey: `projects/${f.projectId}/assets/p2a/voice.mp3`,
        mimeType: 'audio/mpeg',
        sizeBytes: 10n,
        checksumSha256: 'a'.repeat(64),
        metadata: { purpose: 'voiceover', audio: { codec: 'mp3' }, note: 'old' },
        createdById: ctx.ids['editor'] ?? '',
      },
    });
    const forged = await ctx.as('editor', 'PATCH', `/assets/${created.id}`, {
      body: { metadata: { purpose: 'music' } },
    });
    expect([forged.status, codeOf(forged)]).toEqual([422, 'METADATA_KEY_RESERVED']);

    const edited = await ctx.as('editor', 'PATCH', `/assets/${created.id}`, {
      body: { metadata: { note: 'new' } },
    });
    expect(edited.status).toBe(200);
    expect(bodyOf<AssetDto>(edited).metadata).toEqual({
      note: 'new',
      purpose: 'voiceover',
      audio: { codec: 'mp3' },
    });
  });

  it('filters by purpose, review state and text on the server (P2b L1)', async () => {
    const f = await ctx.fixture();
    const mk = (
      name: string,
      metadata: Record<string, string>,
      approvalStatus: 'pending' | 'approved',
    ) =>
      ctx.prisma.asset.create({
        data: {
          projectId: f.projectId,
          assetType: 'audio',
          sourceType: 'upload',
          storageKey: `projects/${f.projectId}/assets/p2b/${name}`,
          mimeType: 'audio/mpeg',
          sizeBytes: 10n,
          checksumSha256: 'b'.repeat(64),
          originalFilename: name,
          metadata,
          approvalStatus,
          createdById: ctx.ids['editor'] ?? '',
        },
      });
    const music = await mk('Calm Piano.mp3', { purpose: 'music' }, 'approved');
    const voice = await mk('narration-1.mp3', { purpose: 'voiceover' }, 'pending');
    const list = async (query: string) =>
      bodyOf<Page<AssetDto>>(
        await ctx.as('viewer', 'GET', `/projects/${f.projectId}/assets?${query}`),
      ).data.map((a) => a.id);
    expect(await list('purpose=music')).toEqual([music.id]);
    expect(await list('assetType=audio&approvalStatus=pending')).toEqual([voice.id]);
    expect(await list('q=piano')).toEqual([music.id]);
  });

  it('filters by asset type and paginates', async () => {
    const f = await ctx.fixture();
    await register(f.projectId, {
      assetType: 'audio',
      mimeType: 'audio/mpeg',
      width: undefined,
      height: undefined,
    });
    const audio = bodyOf<Page<AssetDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/assets?assetType=audio`),
    );
    expect(audio.data.map((a) => a.assetType)).toEqual(['audio']);
    const page = bodyOf<Page<AssetDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/assets?limit=2`),
    );
    expect(page.data).toHaveLength(2);
    expect(page.page.nextCursor).not.toBeNull();
  });
});

describe('lineage', () => {
  it('walks ancestors and paginates descendants breadth-first', async () => {
    const f = await ctx.fixture();
    const derive = async (source: string) =>
      bodyOf<AssetDto>(
        await register(f.projectId, { sourceType: 'derived', sourceAssetId: source }),
      ).id;
    const crop = await derive(f.assetId);
    const cropSmall = await derive(crop);
    const recolor = await derive(f.assetId);

    const up = bodyOf<LineageResponse>(
      await ctx.as('viewer', 'GET', `/assets/${cropSmall}/lineage?direction=ancestors`),
    );
    expect(up.data.map((n) => [n.depth, n.asset.id])).toEqual([
      [1, crop],
      [2, f.assetId],
    ]);

    const page1 = bodyOf<LineageResponse>(
      await ctx.as('viewer', 'GET', `/assets/${f.assetId}/lineage?direction=descendants&limit=2`),
    );
    expect(page1.data.map((n) => n.depth)).toEqual([1, 1]);
    expect(page1.data.map((n) => n.asset.id).sort()).toEqual([crop, recolor].sort());
    const page2 = bodyOf<LineageResponse>(
      await ctx.as(
        'viewer',
        'GET',
        `/assets/${f.assetId}/lineage?direction=descendants&limit=2&cursor=${page1.page.nextCursor ?? ''}`,
      ),
    );
    expect(page2.data.map((n) => [n.depth, n.asset.id])).toEqual([[2, cropSmall]]);
    expect(page2.page.nextCursor).toBeNull();

    const shallow = bodyOf<LineageResponse>(
      await ctx.as('viewer', 'GET', `/assets/${f.assetId}/lineage?direction=descendants&depth=1`),
    );
    expect(shallow.data.every((n) => n.depth === 1)).toBe(true);
  });
});

describe('usages and archive', () => {
  it('lists usages and refuses to archive an asset used by an approved version', async () => {
    const f = await ctx.fixture();
    const usages = bodyOf<{ data: AssetUsageDto[] }>(
      await ctx.as('viewer', 'GET', `/assets/${f.assetId}/usages`),
    );
    expect(usages.data.map((u) => [u.kind, u.reference, u.status]).sort()).toEqual([
      ['character', 'primary', 'draft'],
      ['environment', 'primary', 'draft'],
    ]);

    await ctx.as('editor', 'POST', `/character-versions/${f.characterVersionId}/approve`);
    const res = await ctx.as('editor', 'POST', `/assets/${f.assetId}/archive`);
    expect([res.status, codeOf(res)]).toEqual([409, 'ASSET_IN_USE']);

    const spare = await ctx.as('editor', 'POST', `/assets/${f.spareAssetId}/archive`);
    expect(spare.status).toBe(200);
    const again = await ctx.as('editor', 'POST', `/assets/${f.spareAssetId}/archive`);
    expect([again.status, codeOf(again)]).toEqual([409, 'ARCHIVED']);
    const list = bodyOf<Page<AssetDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/assets`),
    );
    expect(list.data.some((a) => a.id === f.spareAssetId)).toBe(false);
  });

  it('shows what an asset was made from and where it is used in production (P2a A3)', async () => {
    const f = await ctx.fixture();
    // As the worker records a generation input (asset_inputs is append-only lineage).
    await ctx.prisma.assetInput.create({
      data: {
        projectId: f.projectId,
        assetId: f.spareAssetId,
        inputAssetId: f.assetId,
        role: 'scene_reference',
      },
    });
    const inputs = bodyOf<AssetInputListDto>(
      await ctx.as('viewer', 'GET', `/assets/${f.spareAssetId}/inputs`),
    );
    expect(inputs.data.map((i) => [i.role, i.asset.id])).toEqual([['scene_reference', f.assetId]]);

    const usages = bodyOf<AssetUsagesDto>(
      await ctx.as('viewer', 'GET', `/assets/${f.assetId}/usages`),
    );
    expect(usages.production).toEqual([
      expect.objectContaining({
        kind: 'generation_input',
        role: 'scene_reference',
        assetId: f.spareAssetId,
        renderId: null,
      }),
    ]);
    // An asset nothing was made from: empty lists, not an error.
    expect(
      bodyOf<AssetInputListDto>(await ctx.as('viewer', 'GET', `/assets/${f.assetId}/inputs`)).data,
    ).toEqual([]);
    expect((await ctx.as('outsider', 'GET', `/assets/${f.assetId}/inputs`)).status).toBe(404);
  });
});

describe('collections (P2b L5)', () => {
  it('groups assets of one project without touching them, and filters the Library', async () => {
    const f = await ctx.fixture();
    const created = await ctx.as('editor', 'POST', `/projects/${f.projectId}/collections`, {
      body: { name: 'Hero shots' },
    });
    expect(created.status).toBe(201);
    const collection = bodyOf<{ id: string; itemCount: number }>(created);
    const dup = await ctx.as('editor', 'POST', `/projects/${f.projectId}/collections`, {
      body: { name: 'hero SHOTS' },
    });
    expect([dup.status, codeOf(dup)]).toEqual([409, 'NAME_TAKEN']);

    const before = await ctx.prisma.asset.findUniqueOrThrow({ where: { id: f.assetId } });
    for (let i = 0; i < 2; i += 1) {
      const add = await ctx.as(
        'editor',
        'PUT',
        `/collections/${collection.id}/assets/${f.assetId}`,
      );
      expect(bodyOf<{ itemCount: number }>(add).itemCount).toBe(1); // idempotent
    }
    // Membership changes nothing about the asset (identity, metadata, review).
    expect(await ctx.prisma.asset.findUniqueOrThrow({ where: { id: f.assetId } })).toEqual(before);

    const members = bodyOf<Page<AssetDto>>(
      await ctx.as(
        'viewer',
        'GET',
        `/projects/${f.projectId}/assets?collectionId=${collection.id}`,
      ),
    );
    expect(members.data.map((a) => a.id)).toEqual([f.assetId]);

    // Another project's asset cannot join.
    const other = await ctx.fixture();
    const foreign = await ctx.as(
      'editor',
      'PUT',
      `/collections/${collection.id}/assets/${other.assetId}`,
    );
    expect(foreign.status).toBe(422);

    const removed = await ctx.as(
      'editor',
      'DELETE',
      `/collections/${collection.id}/assets/${f.assetId}`,
    );
    expect(removed.status).toBe(204);
    const archived = await ctx.as('editor', 'POST', `/collections/${collection.id}/archive`);
    expect(archived.status).toBe(200);
    const list = bodyOf<{ data: { id: string }[] }>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/collections`),
    );
    expect(list.data.map((c) => c.id)).not.toContain(collection.id);

    // Restore: refused while an active collection took the name, then allowed.
    const taken = await ctx.as('editor', 'POST', `/projects/${f.projectId}/collections`, {
      body: { name: 'Hero shots' },
    });
    const clash = await ctx.as('editor', 'POST', `/collections/${collection.id}/restore`);
    expect([clash.status, codeOf(clash)]).toEqual([409, 'NAME_TAKEN']);
    await ctx.as('editor', 'PATCH', `/collections/${bodyOf<{ id: string }>(taken).id}`, {
      body: { name: 'Hero shots 2' },
    });
    const back = await ctx.as('editor', 'POST', `/collections/${collection.id}/restore`);
    expect([back.status, bodyOf<{ archivedAt: string | null }>(back).archivedAt]).toEqual([
      200,
      null,
    ]);
  });
});
