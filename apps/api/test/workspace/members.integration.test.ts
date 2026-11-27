import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MemberDto } from '@acf/contracts';

import { emailOf } from '../support/workspace.js';
import { bodyOf, codeOf, workspaceContext, type WorkspaceContext } from './shared.js';

let ctx: WorkspaceContext;
beforeAll(async () => {
  ctx = await workspaceContext();
});
afterAll(async () => {
  await ctx.close();
});

const owners = async (projectId: string) =>
  (
    await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'`,
      [projectId],
    )
  ).rows[0]?.n;

describe('members', () => {
  it('lists members with their profile and role', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as('viewer', 'GET', `/projects/${f.projectId}/members`);
    expect(res.status).toBe(200);
    const members = bodyOf<{ data: MemberDto[] }>(res).data;
    expect(members.map((m) => [m.email, m.role]).sort()).toEqual(
      [
        [emailOf('editor'), 'editor'],
        [emailOf('owner'), 'owner'],
        [emailOf('target'), 'editor'],
        [emailOf('viewer'), 'viewer'],
      ].sort(),
    );
  });

  it('adds an existing user by (normalized) email; rejects unknown and duplicate users', async () => {
    const f = await ctx.fixture();
    const path = `/projects/${f.projectId}/members`;
    const added = await ctx.as('owner', 'POST', path, {
      body: { email: ' Invitee@Example.TEST ', role: 'editor' },
    });
    expect(added.status).toBe(201);
    expect(bodyOf<MemberDto>(added)).toMatchObject({ email: emailOf('invitee'), role: 'editor' });

    const again = await ctx.as('owner', 'POST', path, {
      body: { email: emailOf('invitee'), role: 'viewer' },
    });
    expect([again.status, codeOf(again)]).toEqual([409, 'ALREADY_MEMBER']);

    const unknown = await ctx.as('owner', 'POST', path, {
      body: { email: 'nobody@example.test', role: 'viewer' },
    });
    expect([unknown.status, codeOf(unknown)]).toEqual([404, 'USER_NOT_FOUND']);
  });

  it('applies role changes immediately (roles are read per request)', async () => {
    const f = await ctx.fixture();
    expect(
      (await ctx.as('editor', 'PATCH', `/channels/${f.channelId}`, { body: { name: 'x' } })).status,
    ).toBe(200);
    const demote = await ctx.as(
      'owner',
      'PATCH',
      `/projects/${f.projectId}/members/${ctx.ids['editor']}`,
      {
        body: { role: 'viewer' },
      },
    );
    expect(demote.status).toBe(200);
    expect(
      (await ctx.as('editor', 'PATCH', `/channels/${f.channelId}`, { body: { name: 'y' } })).status,
    ).toBe(403);
  });

  it('applies If-Match to role changes', async () => {
    const f = await ctx.fixture();
    const path = `/projects/${f.projectId}/members/${ctx.ids['target']}`;
    const first = await ctx.as('owner', 'PATCH', path, { body: { role: 'viewer' } });
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"\d+"$/);
    const ok = await ctx.as('owner', 'PATCH', path, {
      body: { role: 'editor' },
      headers: { 'if-match': etag },
    });
    expect(ok.status).toBe(200);
    const stale = await ctx.as('owner', 'PATCH', path, {
      body: { role: 'viewer' },
      headers: { 'if-match': etag },
    });
    expect(stale.status).toBe(412);
  });

  it('never removes or demotes the last owner (LAST_OWNER)', async () => {
    const f = await ctx.fixture();
    const self = `/projects/${f.projectId}/members/${ctx.ids['owner']}`;
    const demote = await ctx.as('owner', 'PATCH', self, { body: { role: 'editor' } });
    expect([demote.status, codeOf(demote)]).toEqual([409, 'LAST_OWNER']);
    const remove = await ctx.as('owner', 'DELETE', self);
    expect([remove.status, codeOf(remove)]).toEqual([409, 'LAST_OWNER']);
    expect(await owners(f.projectId)).toBe(1);

    // With a second owner, the first may step down.
    await ctx.as('owner', 'PATCH', `/projects/${f.projectId}/members/${ctx.ids['target']}`, {
      body: { role: 'owner' },
    });
    expect((await ctx.as('owner', 'DELETE', self)).status).toBe(204);
    expect(await owners(f.projectId)).toBe(1);
  });

  it('two owners demoting each other concurrently: exactly one succeeds', async () => {
    const f = await ctx.fixture();
    await ctx.db.query(
      `UPDATE project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2`,
      [f.projectId, ctx.ids['editor']],
    );
    const [a, b] = await Promise.all([
      ctx.as('owner', 'PATCH', `/projects/${f.projectId}/members/${ctx.ids['editor']}`, {
        body: { role: 'viewer' },
      }),
      ctx.as('editor', 'PATCH', `/projects/${f.projectId}/members/${ctx.ids['owner']}`, {
        body: { role: 'viewer' },
      }),
    ]);
    const outcomes = [a, b].map((r) => [r.status, codeOf(r) ?? null]);
    expect(outcomes).toContainEqual([200, null]);
    // The loser is 409: LAST_OWNER if it re-read the committed demotion, or 403 if its own
    // ownership was revoked first (its role is checked at the start of the request).
    const loser = outcomes.find(([status]) => status !== 200);
    expect([
      [409, 'LAST_OWNER'],
      [403, 'FORBIDDEN'],
    ]).toContainEqual(loser);
    expect(await owners(f.projectId)).toBe(1);
  });

  it('reports unknown members as 404', async () => {
    const f = await ctx.fixture();
    const res = await ctx.as(
      'owner',
      'DELETE',
      `/projects/${f.projectId}/members/${ctx.ids['invitee']}`,
    );
    expect(res.status).toBe(404);
  });
});
