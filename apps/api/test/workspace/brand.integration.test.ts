// Characters/environments, versions and approval (ADR-0010; design package §7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Page, VersionDto, VersionedEntityDto } from '@acf/contracts';

import { newAsset } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const newVersion = (characterId: string, body: Record<string, unknown>) =>
  ctx.as('editor', 'POST', `/characters/${characterId}/versions`, { body });
const approve = (versionId: string, etag?: string) =>
  ctx.as('editor', 'POST', `/character-versions/${versionId}/approve`, {
    ...(etag ? { headers: { 'if-match': etag } } : {}),
  });
const masterOf = async (characterId: string) =>
  bodyOf<VersionedEntityDto>(await ctx.as('viewer', 'GET', `/characters/${characterId}`)).master;

/** Invariants that must hold after any interleaving (ADR-0010/0011). */
async function invariants() {
  const q = async (sql: string) => (await ctx.db.query<{ n: number }>(sql)).rows[0]?.n;
  return {
    masterNotHighestApproved: await q(`SELECT count(*)::int AS n FROM characters c
      WHERE c.master_version_id IS DISTINCT FROM (SELECT id FROM character_versions v
        WHERE v.character_id = c.id AND v.status = 'approved' ORDER BY version DESC LIMIT 1)`),
    approvedWithArchivedAsset: await q(`SELECT count(*)::int AS n FROM character_versions v
      JOIN assets a ON a.archived_at IS NOT NULL AND (a.id = v.primary_asset_id
        OR a.id IN (SELECT asset_id FROM character_version_assets l WHERE l.character_version_id = v.id))
      WHERE v.status = 'approved'`),
  };
}

describe('characters', () => {
  it('creates a character without a master; slugs are unique per project', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('editor', 'POST', `/projects/${f.projectId}/characters`, {
      body: { name: 'Minh', slug: 'minh', description: 'Host' },
    });
    expect(res.status).toBe(201);
    expect(bodyOf<VersionedEntityDto>(res)).toMatchObject({ slug: 'minh', master: null });
    expect(res.headers.get('etag')).toMatch(/^W\/"\d+"$/);

    const dup = await ctx.as('editor', 'POST', `/projects/${f.projectId}/characters`, {
      body: { name: 'Again', slug: 'minh' },
    });
    expect([dup.status, codeOf(dup)]).toEqual([409, 'SLUG_TAKEN']);

    const list = bodyOf<Page<VersionedEntityDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/characters`),
    );
    expect(list.data.map((c) => c.slug)).toEqual(['minh', 'khanh']);
  });

  it('cannot set the master directly', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('editor', 'PATCH', `/characters/${f.characterId}`, {
      body: { masterVersionId: f.characterVersionId },
    });
    expect(res.status).toBe(400);
  });
});

describe('version lifecycle', () => {
  it('edits drafts, approves into the master, then freezes the version', async () => {
    const f = await ctx.fixture();
    const v1 = f.characterVersionId;
    const edited = await ctx.as('editor', 'PATCH', `/character-versions/${v1}`, {
      body: { description: 'Front-facing master', rules: { hair: 'short black' } },
    });
    expect(bodyOf<VersionDto>(edited)).toMatchObject({
      description: 'Front-facing master',
      rules: { hair: 'short black' },
    });
    const linked = await ctx.as('editor', 'PUT', `/character-versions/${v1}/assets`, {
      body: { assets: [{ assetId: f.spareAssetId, sortOrder: 1, note: 'side' }] },
    });
    expect(bodyOf<VersionDto>(linked).assets).toEqual([
      { assetId: f.spareAssetId, sortOrder: 1, note: 'side' },
    ]);

    const approved = await approve(v1);
    expect(approved.status).toBe(200);
    expect(bodyOf<VersionDto>(approved)).toMatchObject({
      status: 'approved',
      approvedById: ctx.ids['editor'],
    });
    expect(await masterOf(f.characterId)).toMatchObject({ id: v1, version: 1 });

    for (const [method, path, body] of [
      ['PATCH', `/character-versions/${v1}`, { description: 'tampered' }],
      ['PUT', `/character-versions/${v1}/assets`, { assets: [] }],
    ] as const) {
      const res = await ctx.as('editor', method, path, { body });
      expect([res.status, codeOf(res)], `${method} ${path}`).toEqual([409, 'VERSION_IMMUTABLE']);
    }
    const again = await approve(v1);
    expect([again.status, codeOf(again)]).toEqual([409, 'ALREADY_APPROVED']);
    expect((again.json as { error: { current: VersionDto } }).error.current.id).toBe(v1);
  });

  it('rolls back append-only: a new draft based on an old version copies it and becomes master', async () => {
    const f = await ctx.fixture();
    await ctx.as('editor', 'PATCH', `/character-versions/${f.characterVersionId}`, {
      body: { rules: { outfit: 'blue' } },
    });
    await ctx.as('editor', 'PUT', `/character-versions/${f.characterVersionId}/assets`, {
      body: { assets: [{ assetId: f.spareAssetId }] },
    });
    await approve(f.characterVersionId);
    const v2 = bodyOf<VersionDto>(
      await newVersion(f.characterId, { description: 'v2 experiment' }),
    );
    await approve(v2.id);

    const v3res = await newVersion(f.characterId, { basedOnVersionId: f.characterVersionId });
    expect(v3res.status).toBe(201);
    const v3 = bodyOf<VersionDto>(v3res);
    expect(v3).toMatchObject({
      version: 3,
      status: 'draft',
      description: 'v1',
      rules: { outfit: 'blue' },
      primaryAssetId: f.assetId,
      basedOnVersionId: f.characterVersionId,
      assets: [{ assetId: f.spareAssetId, sortOrder: 0, note: null }],
    });
    await approve(v3.id);
    expect(await masterOf(f.characterId)).toMatchObject({ id: v3.id, version: 3 });

    const versions = bodyOf<Page<VersionDto>>(
      await ctx.as('viewer', 'GET', `/characters/${f.characterId}/versions?limit=2`),
    );
    expect(versions.data.map((v) => v.version)).toEqual([3, 2]);
    expect(versions.page.nextCursor).not.toBeNull();
  });

  it('refuses to approve a draft older than the master (STALE_DRAFT, U2)', async () => {
    const f = await ctx.fixture();
    const v2 = bodyOf<VersionDto>(await newVersion(f.characterId, { description: 'v2' }));
    expect((await approve(v2.id)).status).toBe(200);
    const stale = await approve(f.characterVersionId);
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STALE_DRAFT']);
    expect(await masterOf(f.characterId)).toMatchObject({ version: 2 });
  });

  it('approve honours If-Match, and link changes change the ETag', async () => {
    const f = await ctx.fixture();
    const reviewed = await ctx.as('viewer', 'GET', `/character-versions/${f.characterVersionId}`);
    const etag = reviewed.headers.get('etag') ?? '';
    await ctx.as('editor', 'PUT', `/character-versions/${f.characterVersionId}/assets`, {
      body: { assets: [{ assetId: f.spareAssetId }] },
    });
    const res = await approve(f.characterVersionId, etag);
    expect([res.status, codeOf(res)]).toEqual([412, 'PRECONDITION_FAILED']);

    const fresh =
      (await ctx.as('viewer', 'GET', `/character-versions/${f.characterVersionId}`)).headers.get(
        'etag',
      ) ?? '';
    expect((await approve(f.characterVersionId, fresh)).status).toBe(200);
  });

  it('refuses archived and foreign assets', async () => {
    const f = await ctx.fixture();
    const other = await ctx.fixture();
    const foreign = await newVersion(f.characterId, {
      description: 'x',
      primaryAssetId: other.assetId,
    });
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'REFERENCE_NOT_FOUND']);

    // Archiving an asset used only by drafts is allowed (U4); approval then refuses (AC010).
    const archivedRes = await ctx.as('editor', 'POST', `/assets/${f.assetId}/archive`);
    expect(archivedRes.status).toBe(200);
    const res = await approve(f.characterVersionId);
    expect([res.status, codeOf(res)]).toEqual([409, 'ASSET_ARCHIVED']);
    const newRef = await newVersion(f.characterId, { description: 'x', primaryAssetId: f.assetId });
    expect([newRef.status, codeOf(newRef)]).toEqual([409, 'ASSET_ARCHIVED']);
  });

  it('makes an archived character read-only', async () => {
    const f = await ctx.fixture();
    await ctx.as('editor', 'POST', `/characters/${f.characterId}/archive`);
    for (const [method, path, body] of [
      ['POST', `/characters/${f.characterId}/versions`, { description: 'x' }],
      ['PATCH', `/character-versions/${f.characterVersionId}`, { description: 'x' }],
      ['POST', `/character-versions/${f.characterVersionId}/approve`, undefined],
      ['PATCH', `/characters/${f.characterId}`, { name: 'x' }],
    ] as const) {
      const res = await ctx.as('editor', method, path, body === undefined ? {} : { body });
      expect([res.status, codeOf(res)], `${method} ${path}`).toEqual([409, 'ARCHIVED']);
    }
    expect((await ctx.as('viewer', 'GET', `/characters/${f.characterId}/versions`)).status).toBe(
      200,
    );
  });

  it('works the same for environments (visual rules)', async () => {
    const f = await ctx.fixture();
    const edited = await ctx.as(
      'editor',
      'PATCH',
      `/environment-versions/${f.environmentVersionId}`,
      {
        body: { rules: { lighting: 'warm' } },
      },
    );
    expect(bodyOf<VersionDto>(edited).rules).toEqual({ lighting: 'warm' });
    const approved = await ctx.as(
      'editor',
      'POST',
      `/environment-versions/${f.environmentVersionId}/approve`,
    );
    expect(approved.status).toBe(200);
    const env = bodyOf<VersionedEntityDto>(
      await ctx.as('viewer', 'GET', `/environments/${f.environmentId}`),
    );
    expect(env.master).toMatchObject({ id: f.environmentVersionId, version: 1 });
    const { rows } = await ctx.db.query<{ visual_rules: unknown }>(
      'SELECT visual_rules FROM environment_versions WHERE id = $1',
      [f.environmentVersionId],
    );
    expect(rows[0]?.visual_rules).toEqual({ lighting: 'warm' });
  });
});

/**
 * Deadlocks in the test database so far. PostgreSQL publishes the counter asynchronously, so
 * wait until it stops changing (ADR-0011 §6: a 40P01 on a service path is a defect, even when
 * the transaction runner's retry hides it from the client).
 */
async function deadlockCount(): Promise<number> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await ctx.db.query('SELECT pg_stat_clear_snapshot()');
    const { rows } = await ctx.db.query<{ n: string }>(
      'SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()',
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n === last) return n;
    last = n;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return last;
}

describe('concurrency (service paths, READ COMMITTED)', () => {
  it.each([
    ['without existing links', false],
    ['with existing links', true],
  ])(
    'concurrent link replacements %s never deadlock or merge (ADR-0011 §5 exception)',
    async (_name, linked) => {
      const before = await deadlockCount();
      for (let round = 0; round < 10; round++) {
        const f = await ctx.fixture();
        const extra = bodyOf<{ id: string }>(
          await ctx.as('editor', 'POST', `/projects/${f.projectId}/assets`, {
            body: newAsset(f.projectId),
          }),
        ).id;
        const path = `/character-versions/${f.characterVersionId}/assets`;
        if (linked) {
          await ctx.as('editor', 'PUT', path, { body: { assets: [{ assetId: f.assetId }] } });
        }
        const [a, b] = await Promise.all([
          ctx.as('editor', 'PUT', path, { body: { assets: [{ assetId: f.spareAssetId }] } }),
          ctx.as('owner', 'PUT', path, { body: { assets: [{ assetId: extra }] } }),
        ]);
        expect([a.status, b.status]).toEqual([200, 200]);
        // Last writer wins (no If-Match): exactly one of the two link sets remains.
        const final = bodyOf<VersionDto>(
          await ctx.as('viewer', 'GET', `/character-versions/${f.characterVersionId}`),
        );
        expect([[f.spareAssetId], [extra]]).toContainEqual(final.assets.map((l) => l.assetId));
      }
      expect(await deadlockCount()).toBe(before);
    },
  );

  it('concurrent approvals of v1 and v2: the master ends at the highest approved version', async () => {
    for (let round = 0; round < 5; round++) {
      const f = await ctx.fixture();
      const v2 = bodyOf<VersionDto>(await newVersion(f.characterId, { description: 'v2' }));
      const [a, b] = await Promise.all([approve(f.characterVersionId), approve(v2.id)]);
      expect([200, 409]).toContain(a.status); // v1 loses with STALE_DRAFT if v2 committed first
      expect(b.status).toBe(200);
      if (a.status === 409) expect(codeOf(a)).toBe('STALE_DRAFT');
      expect(await masterOf(f.characterId)).toMatchObject({ id: v2.id });
    }
    expect(await invariants()).toEqual({
      masterNotHighestApproved: 0,
      approvedWithArchivedAsset: 0,
    });
  });

  it('approval racing an archive of its asset: exactly one wins, never both', async () => {
    for (let round = 0; round < 5; round++) {
      const f = await ctx.fixture();
      const [approval, archive] = await Promise.all([
        approve(f.characterVersionId),
        ctx.as('editor', 'POST', `/assets/${f.assetId}/archive`),
      ]);
      const outcome = [approval.status, archive.status].sort();
      expect(outcome).toEqual([200, 409]);
      const loser = approval.status === 409 ? codeOf(approval) : codeOf(archive);
      expect(['ASSET_ARCHIVED', 'ASSET_IN_USE']).toContain(loser);
    }
    expect(await invariants()).toEqual({
      masterNotHighestApproved: 0,
      approvedWithArchivedAsset: 0,
    });
  });
});

describe('asset registration feeds versions', () => {
  it('links a newly registered asset', async () => {
    const f = await ctx.fixture();
    const asset = await ctx.as('editor', 'POST', `/projects/${f.projectId}/assets`, {
      body: newAsset(f.projectId),
    });
    const id = (asset.json as { id: string }).id;
    const v = await newVersion(f.characterId, {
      description: 'with new asset',
      assets: [{ assetId: id }],
    });
    expect(bodyOf<VersionDto>(v).assets.map((l) => l.assetId)).toEqual([id]);
  });
});
