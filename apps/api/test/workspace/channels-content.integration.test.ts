import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelDto, ContentItemDto, Page } from '@acf/contracts';

import { newContent } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('channels', () => {
  it('creates, lists, updates and archives a channel', async () => {
    const f = await ctx.fixture();
    const created = await ctx.as('editor', 'POST', `/projects/${f.projectId}/channels`, {
      body: { name: 'Shorts', slug: 'shorts', platform: 'youtube_shorts', handle: '@acf' },
    });
    expect(created.status).toBe(201);
    const channel = bodyOf<ChannelDto>(created);
    expect(channel).toMatchObject({ slug: 'shorts', platform: 'youtube_shorts', handle: '@acf' });

    const cleared = await ctx.as('editor', 'PATCH', `/channels/${channel.id}`, {
      body: { handle: '' },
    });
    expect(bodyOf<ChannelDto>(cleared).handle).toBeNull();

    const dup = await ctx.as('editor', 'POST', `/projects/${f.projectId}/channels`, {
      body: { name: 'Dup', slug: 'shorts', platform: 'other' },
    });
    expect([dup.status, codeOf(dup)]).toEqual([409, 'SLUG_TAKEN']);

    // The same slug is fine in another project.
    const other = await ctx.fixture();
    expect(
      (
        await ctx.as('editor', 'POST', `/projects/${other.projectId}/channels`, {
          body: { name: 'Shorts', slug: 'shorts', platform: 'other' },
        })
      ).status,
    ).toBe(201);

    expect((await ctx.as('editor', 'POST', `/channels/${channel.id}/archive`)).status).toBe(200);
    const again = await ctx.as('editor', 'POST', `/channels/${channel.id}/archive`);
    expect([again.status, codeOf(again)]).toEqual([409, 'ARCHIVED']);
    const edit = await ctx.as('editor', 'PATCH', `/channels/${channel.id}`, {
      body: { name: 'x' },
    });
    expect([edit.status, codeOf(edit)]).toEqual([409, 'ARCHIVED']);

    const list = bodyOf<Page<ChannelDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/channels`),
    );
    expect(list.data.map((c) => c.slug)).toEqual(['main']);
    const all = bodyOf<Page<ChannelDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/channels?includeArchived=true`),
    );
    expect(all.data.map((c) => c.slug)).toEqual(['shorts', 'main']);
  });

  it('returns 404 for a missing channel and 400 for a malformed id', async () => {
    expect((await ctx.as('owner', 'GET', `/channels/${randomUUID()}`)).status).toBe(404);
    expect((await ctx.as('owner', 'GET', '/channels/not-a-uuid')).status).toBe(400);
  });
});

describe('content items', () => {
  it('creates a draft from a brief; status is not client-writable', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: newContent(f.channelId),
    });
    expect(res.status).toBe(201);
    const item = bodyOf<ContentItemDto>(res);
    expect(item).toMatchObject({
      status: 'draft',
      aspectRatio: '9:16',
      channelId: f.channelId,
      brief: { topic: 'Useful desk gadgets', audience: 'Office workers' },
    });

    const withStatus = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: { ...newContent(), status: 'approved' },
    });
    expect(withStatus.status).toBe(400);
    const patchStatus = await ctx.as('editor', 'PATCH', `/content/${item.id}`, {
      body: { status: 'approved' },
    });
    expect(patchStatus.status).toBe(400);
  });

  it('validates the brief and the duration', async () => {
    const f = await ctx.fixture();
    for (const bad of [
      { ...newContent(), brief: {} },
      { ...newContent(), brief: { topic: 'x', extra: 1 } },
      { ...newContent(), brief: { topic: 'x', sourceUrls: ['ftp://example.com'] } },
      { ...newContent(), targetDurationSeconds: 601 },
      { ...newContent(), aspectRatio: '4:3' },
    ]) {
      const res = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, { body: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("rejects another project's channel (422) and an archived channel (409)", async () => {
    const f = await ctx.fixture();
    const other = await ctx.fixture();
    const foreign = await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, {
      body: newContent(other.channelId),
    });
    expect([foreign.status, codeOf(foreign)]).toEqual([422, 'REFERENCE_NOT_FOUND']);

    await ctx.as('editor', 'POST', `/channels/${f.channelId}/archive`);
    const archivedChannel = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { channelId: f.channelId },
    });
    expect([archivedChannel.status, codeOf(archivedChannel)]).toEqual([409, 'ARCHIVED']);

    const detach = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { channelId: null },
    });
    expect(bodyOf<ContentItemDto>(detach).channelId).toBeNull();
  });

  it('filters by channel and status, and paginates', async () => {
    const f = await ctx.fixture();
    for (let i = 0; i < 3; i++) {
      await ctx.as('editor', 'POST', `/projects/${f.projectId}/content`, { body: newContent() });
    }
    const byChannel = bodyOf<Page<ContentItemDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/content?channelId=${f.channelId}`),
    );
    expect(byChannel.data.map((c) => c.id)).toEqual([f.contentId]);

    const page1 = bodyOf<Page<ContentItemDto>>(
      await ctx.as('viewer', 'GET', `/projects/${f.projectId}/content?limit=3&status=draft`),
    );
    expect(page1.data).toHaveLength(3);
    const page2 = bodyOf<Page<ContentItemDto>>(
      await ctx.as(
        'viewer',
        'GET',
        `/projects/${f.projectId}/content?limit=3&status=draft&cursor=${page1.page.nextCursor ?? ''}`,
      ),
    );
    expect(page2.data.map((c) => c.id)).toEqual([f.contentId]);
    expect(page2.page.nextCursor).toBeNull();
  });

  it('updates with If-Match and archives', async () => {
    const f = await ctx.fixture();
    const get = await ctx.as('viewer', 'GET', `/content/${f.contentId}`);
    const etag = get.headers.get('etag') ?? '';
    const ok = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { aspectRatio: '1:1', brief: { topic: 'New topic' } },
      headers: { 'if-match': etag },
    });
    expect(bodyOf<ContentItemDto>(ok)).toMatchObject({
      aspectRatio: '1:1',
      brief: { topic: 'New topic' },
    });
    const stale = await ctx.as('editor', 'PATCH', `/content/${f.contentId}`, {
      body: { title: 'x' },
      headers: { 'if-match': etag },
    });
    expect(stale.status).toBe(412);
    expect((await ctx.as('editor', 'POST', `/content/${f.contentId}/archive`)).status).toBe(200);
    expect((await ctx.as('viewer', 'GET', `/content/${f.contentId}`)).status).toBe(200);
  });
});
