import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Page, ProjectDto } from '@acf/contracts';

import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const create = (slug: string, extra: Record<string, unknown> = {}) =>
  ctx.as('editor', 'POST', '/projects', {
    body: {
      name: 'Ngân Khánh Content',
      slug,
      defaultLanguage: 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
      ...extra,
    },
  });

describe('projects', () => {
  it('creates a project whose creator is its owner, with an ETag', async () => {
    const res = await create('ngan-khanh-content', { description: 'Brand channel' });
    expect(res.status).toBe(201);
    const project = bodyOf<ProjectDto>(res);
    expect(project).toMatchObject({
      slug: 'ngan-khanh-content',
      role: 'owner',
      description: 'Brand channel',
      archivedAt: null,
    });
    const { rows } = await ctx.db.query<{ role: string; added_by_id: string }>(
      'SELECT role, added_by_id FROM project_members WHERE project_id = $1',
      [project.id],
    );
    expect(rows).toEqual([{ role: 'owner', added_by_id: ctx.ids['editor'] }]);

    const get = await ctx.as('editor', 'GET', `/projects/${project.id}`);
    expect(get.status).toBe(200);
  });

  it('canonicalizes the language tag and validates the time zone and slug', async () => {
    const ok = await create('canonical-lang', { defaultLanguage: 'en-us' });
    expect(bodyOf<ProjectDto>(ok).defaultLanguage).toBe('en-US');

    for (const bad of [
      { slug: 'Bad Slug' },
      { slug: 'x', timezone: 'Mars/Olympus' },
      { slug: 'y', defaultLanguage: 'not a tag!' },
      { slug: 'z', unknown: true },
    ]) {
      const res = await create(bad.slug, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a duplicate slug globally with SLUG_TAKEN', async () => {
    expect((await create('taken-slug')).status).toBe(201);
    const res = await create('taken-slug');
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('SLUG_TAKEN');
  });

  it("lists only the caller's projects, newest first, with cursor pagination", async () => {
    for (const s of ['page-a', 'page-b', 'page-c']) {
      await ctx.as('viewer', 'POST', '/projects', {
        body: { name: s, slug: s, defaultLanguage: 'vi', timezone: 'UTC' },
      });
    }
    const first = await ctx.as('viewer', 'GET', '/projects?limit=2');
    const page1 = bodyOf<Page<ProjectDto>>(first);
    expect(page1.data.map((p) => p.slug)).toEqual(['page-c', 'page-b']);
    expect(page1.page.nextCursor).toEqual(expect.any(String));

    const second = await ctx.as(
      'viewer',
      'GET',
      `/projects?limit=2&cursor=${page1.page.nextCursor ?? ''}`,
    );
    const page2 = bodyOf<Page<ProjectDto>>(second);
    expect(page2.data.map((p) => p.slug)).toEqual(['page-a']);
    expect(page2.page.nextCursor).toBeNull();

    const outsider = bodyOf<Page<ProjectDto>>(await ctx.as('outsider', 'GET', '/projects'));
    expect(outsider.data).toEqual([]);

    const bad = await ctx.as('viewer', 'GET', '/projects?cursor=garbage');
    expect(codeOf(bad)).toBe('INVALID_CURSOR');
  });

  it('applies If-Match: a stale ETag is 412, the current one succeeds', async () => {
    const f = await ctx.fixture();
    const get = await ctx.as('owner', 'GET', `/projects/${f.projectId}`);
    expect(get.status).toBe(200);
    const etag = get.headers.get('etag') ?? '';
    expect(etag).toBe(`W/"${new Date(bodyOf<ProjectDto>(get).updatedAt).getTime()}"`);

    const ok = await ctx.as('owner', 'PATCH', `/projects/${f.projectId}`, {
      body: { name: 'Renamed' },
      headers: { 'if-match': etag },
    });
    expect(ok.status).toBe(200);
    expect(bodyOf<ProjectDto>(ok).name).toBe('Renamed');

    const stale = await ctx.as('owner', 'PATCH', `/projects/${f.projectId}`, {
      body: { name: 'Again' },
      headers: { 'if-match': etag },
    });
    expect(stale.status).toBe(412);
    expect(codeOf(stale)).toBe('PRECONDITION_FAILED');
  });

  it('archiving makes the project read-only and hides it from the default list', async () => {
    const f = await ctx.fixture();
    const archived = await ctx.as('owner', 'POST', `/projects/${f.projectId}/archive`);
    expect(archived.status).toBe(200);
    expect(bodyOf<ProjectDto>(archived).archivedAt).not.toBeNull();

    expect((await ctx.as('viewer', 'GET', `/projects/${f.projectId}`)).status).toBe(200);
    for (const [method, path, body] of [
      ['PATCH', `/projects/${f.projectId}`, { name: 'x' }],
      ['POST', `/projects/${f.projectId}/archive`, undefined],
      ['POST', `/projects/${f.projectId}/channels`, { name: 'c', slug: 'c', platform: 'other' }],
      ['PATCH', `/channels/${f.channelId}`, { name: 'x' }],
      ['PATCH', `/content/${f.contentId}`, { title: 'x' }],
      [
        'POST',
        `/projects/${f.projectId}/members`,
        { email: 'invitee@example.test', role: 'viewer' },
      ],
    ] as const) {
      const res = await ctx.as('owner', method, path, body === undefined ? {} : { body });
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(codeOf(res)).toBe('ARCHIVED');
    }

    const listed = bodyOf<Page<ProjectDto>>(await ctx.as('owner', 'GET', '/projects?limit=100'));
    expect(listed.data.some((p) => p.id === f.projectId)).toBe(false);
    const withArchived = bodyOf<Page<ProjectDto>>(
      await ctx.as('owner', 'GET', '/projects?limit=100&includeArchived=true'),
    );
    expect(withArchived.data.some((p) => p.id === f.projectId)).toBe(true);
  });

  it('restoring (owner only) makes the project writable again', async () => {
    const f = await ctx.fixture();
    expect((await ctx.as('owner', 'POST', `/projects/${f.projectId}/archive`)).status).toBe(200);
    expect((await ctx.as('editor', 'POST', `/projects/${f.projectId}/restore`)).status).toBe(403);
    const restored = await ctx.as('owner', 'POST', `/projects/${f.projectId}/restore`);
    expect(restored.status).toBe(200);
    expect(bodyOf<ProjectDto>(restored).archivedAt).toBeNull();
    const edit = await ctx.as('owner', 'PATCH', `/projects/${f.projectId}`, {
      body: { name: 'Back' },
    });
    expect(edit.status).toBe(200);
  });
});
