// R0: content masters and variants over HTTP (docs/design/M3.5-multiformat-architecture-review.md
// §5, ADR-0015). Content items are variants; the M1–M3 content endpoints keep their behaviour.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BriefValidationDto,
  ContentItemDto,
  ContentMasterDetailDto,
  ContentMasterDto,
  Page,
} from '@acf/contracts';

import { newContent } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const masterBody = { title: 'Desk gadgets', brief: { topic: 'Desk gadgets' }, language: 'vi' };
const variantBody = { format: 'short_video', targetDurationSeconds: 30, aspectRatio: '9:16' };

describe('POST /projects/:projectId/content (unchanged body)', () => {
  it('creates the master and its first variant together', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: newContent(f.channelId),
    });
    expect(res.status).toBe(201);
    const item = bodyOf<ContentItemDto>(res);
    expect(item).toMatchObject({
      targetPlatform: 'tiktok', // from the channel
      masterBriefRevision: 1,
      masterBriefStale: false,
    });
    const master = bodyOf<ContentMasterDetailDto>(
      await ctx.as('viewer', 'GET', `/content-masters/${item.contentMasterId}`),
    );
    expect(master).toMatchObject({
      title: item.title,
      brief: item.brief,
      language: item.language,
      briefRevision: 1,
      activeVariantCount: 1,
    });
    expect(master.variants.map((v) => v.id)).toEqual([item.id]);
  });

  it('accepts a target platform without a channel, and only a matching one with a channel', async () => {
    const f = await ctx.fixture();
    const free = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: { ...newContent(), targetPlatform: 'youtube_shorts' },
    });
    expect(bodyOf<ContentItemDto>(free).targetPlatform).toBe('youtube_shorts');
    const same = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: { ...newContent(f.channelId), targetPlatform: 'tiktok' },
    });
    expect(same.status).toBe(201);
    const mismatch = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: { ...newContent(f.channelId), targetPlatform: 'instagram_reels' },
    });
    expect([mismatch.status, codeOf(mismatch)]).toEqual([422, 'PLATFORM_CHANNEL_MISMATCH']);
    const masters = bodyOf<Page<ContentMasterDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/content-masters`),
    );
    // Fixture master + two created; the rejected request left no master behind.
    expect(masters.data).toHaveLength(3);
  });

  it('keeps the platform consistent when the channel changes on PATCH', async () => {
    const f = await ctx.fixture();
    const moved = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { channelId: null, targetPlatform: 'instagram_reels' },
    });
    expect(bodyOf<ContentItemDto>(moved)).toMatchObject({
      channelId: null,
      targetPlatform: 'instagram_reels',
    });
    const back = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { channelId: f.channelId },
    });
    expect(bodyOf<ContentItemDto>(back)).toMatchObject({
      channelId: f.channelId,
      targetPlatform: 'tiktok',
    });
    const clash = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { targetPlatform: 'youtube_shorts' },
    });
    expect([clash.status, codeOf(clash)]).toEqual([422, 'PLATFORM_CHANNEL_MISMATCH']);
  });
});

describe('content masters', () => {
  it('creates a master, adds variants that copy its brief, and lists them', async () => {
    const f = await ctx.fixture();
    const master = bodyOf<ContentMasterDto>(
      await ctx.as('editor', 'POST', `/projects/${f.projectId}/content-masters`, {
        body: masterBody,
      }),
    );
    expect(master).toMatchObject({ briefRevision: 1, activeVariantCount: 0 });

    const short = await ctx.as('editor', 'POST', `/content-masters/${master.id}/variants`, {
      body: { ...variantBody, channelId: f.channelId },
    });
    expect(short.status).toBe(201);
    expect(bodyOf<ContentItemDto>(short)).toMatchObject({
      title: 'Desk gadgets',
      language: 'vi',
      brief: masterBody.brief,
      contentMasterId: master.id,
      targetPlatform: 'tiktok',
      status: 'draft',
    });
    const square = await ctx.as('editor', 'POST', `/content-masters/${master.id}/variants`, {
      body: {
        ...variantBody,
        title: 'Desk gadgets (EN)',
        aspectRatio: '1:1',
        language: 'en',
        targetPlatform: 'instagram_reels',
      },
    });
    expect(bodyOf<ContentItemDto>(square)).toMatchObject({
      title: 'Desk gadgets (EN)',
      language: 'en',
      aspectRatio: '1:1',
      targetPlatform: 'instagram_reels',
    });

    const detail = bodyOf<ContentMasterDetailDto>(
      await ctx.as('viewer', 'GET', `/content-masters/${master.id}`),
    );
    expect(detail.activeVariantCount).toBe(2);
    expect(detail.variants).toHaveLength(2);
    // Variants are ordinary content items for every M1–M3 endpoint.
    const listed = bodyOf<Page<ContentItemDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/content`),
    );
    expect(listed.data.filter((c) => c.contentMasterId === master.id)).toHaveLength(2);
  });

  it('marks variants stale when the master brief changes, and resync clears it', async () => {
    const f = await ctx.fixture();
    const before = bodyOf<ContentItemDto>(await ctx.as('viewer', 'GET', `/content/${f.contentId}`));
    expect(before.masterBriefStale).toBe(false);

    const sameBrief = await ctx.as('editor', 'PATCH', `/content-masters/${f.contentMasterId}`, {
      body: { title: 'Renamed', brief: { topic: 'Desk gadgets' } },
    });
    expect(bodyOf<ContentMasterDto>(sameBrief).briefRevision).toBe(1); // unchanged content

    const edited = await ctx.as('editor', 'PATCH', `/content-masters/${f.contentMasterId}`, {
      body: { brief: { topic: 'Desk gadgets under 20 USD', tone: 'playful' } },
    });
    expect(bodyOf<ContentMasterDto>(edited).briefRevision).toBe(2);
    const stale = bodyOf<ContentItemDto>(await ctx.as('viewer', 'GET', `/content/${f.contentId}`));
    expect(stale).toMatchObject({ masterBriefStale: true, brief: before.brief });

    const synced = await ctx.as('editor', 'POST', `/content/${f.contentId}/brief/resync`);
    expect(synced.status).toBe(200);
    expect(bodyOf<ContentItemDto>(synced)).toMatchObject({
      masterBriefStale: false,
      masterBriefRevision: 2,
      brief: { topic: 'Desk gadgets under 20 USD', tone: 'playful' },
    });

    // Editing the variant's own brief does not touch the master.
    await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { brief: { topic: 'TikTok cut' } },
    });
    const master = bodyOf<ContentMasterDto>(
      await ctx.as('viewer', 'GET', `/content-masters/${f.contentMasterId}`),
    );
    expect(master).toMatchObject({
      briefRevision: 2,
      brief: { topic: 'Desk gadgets under 20 USD' },
    });
  });

  it('honours If-Match on master edits', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('editor', 'PATCH', `/content-masters/${f.contentMasterId}`, {
      body: { title: 'x' },
      headers: { 'if-match': 'W/"1"' },
    });
    expect([res.status, codeOf(res)]).toEqual([412, 'PRECONDITION_FAILED']);
  });

  it('archives a master only after its variants, then refuses new variants', async () => {
    const f = await ctx.fixture();
    const blocked = await ctx.as('editor', 'POST', `/content-masters/${f.contentMasterId}/archive`);
    expect([blocked.status, codeOf(blocked)]).toEqual([409, 'MASTER_HAS_ACTIVE_VARIANTS']);

    expect((await ctx.as('editor', 'POST', `/content/${f.contentId}/archive`)).status).toBe(200);
    const done = await ctx.as('editor', 'POST', `/content-masters/${f.contentMasterId}/archive`);
    expect(done.status).toBe(200);
    expect(bodyOf<ContentMasterDto>(done).archivedAt).not.toBeNull();

    const late = await ctx.as('editor', 'POST', `/content-masters/${f.contentMasterId}/variants`, {
      body: variantBody,
    });
    expect([late.status, codeOf(late)]).toEqual([409, 'ARCHIVED']);
    const edit = await ctx.as('editor', 'PATCH', `/content-masters/${f.contentMasterId}`, {
      body: { title: 'y' },
    });
    expect([edit.status, codeOf(edit)]).toEqual([409, 'ARCHIVED']);

    const active = bodyOf<Page<ContentMasterDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/content-masters`),
    );
    expect(active.data.map((m) => m.id)).not.toContain(f.contentMasterId);
    const all = bodyOf<Page<ContentMasterDto>>(
      await ctx.as(
        'viewer',
        'GET',
        `/projects/${f.projectId}/content-masters?includeArchived=true`,
      ),
    );
    expect(all.data.map((m) => m.id)).toContain(f.contentMasterId);
  });

  it('rejects channels from other projects and unknown masters', async () => {
    const f = await ctx.fixture();
    const other = await ctx.fixture();
    const res = await ctx.as('owner', 'POST', `/content-masters/${f.contentMasterId}/variants`, {
      body: { ...variantBody, channelId: other.channelId },
    });
    expect([res.status, codeOf(res)]).toEqual([422, 'REFERENCE_NOT_FOUND']);
    expect((await ctx.as('owner', 'GET', `/content-masters/${randomUUID()}`)).status).toBe(404);
    expect((await ctx.as('owner', 'GET', '/content-masters/not-a-uuid')).status).toBe(400);
  });
});

describe('brief validation with a platform (warnings only)', () => {
  it('warns when a variant exceeds a verified platform limit', async () => {
    const f = await ctx.fixture();
    const item = bodyOf<ContentItemDto>(
      await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
        body: { ...newContent(), targetDurationSeconds: 200, targetPlatform: 'youtube_shorts' },
      }),
    );
    const result = bodyOf<BriefValidationDto>(
      await ctx.as('viewer', 'POST', `/content/${item.id}/brief/validate`),
    );
    expect(result.warnings).toContainEqual({
      path: 'targetDurationSeconds',
      message: expect.stringContaining('YouTube Shorts') as string,
    });
  });
});
