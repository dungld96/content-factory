// Table-driven permission matrix (design package §8.2) for the M1c endpoints. Every row runs for
// every caller: unauthenticated, non-member, viewer, editor, owner. Each call gets a fresh
// fixture project, so destructive successes never affect another cell. M1e extends the table to
// every route and asserts that the table covers all registered routes.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';

import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import {
  actAs,
  createFixture,
  emailOf,
  newContent,
  seedUsers,
  signInAll,
  type Fixture,
  type Persona,
} from '../support/workspace.js';

type Caller = 'unauthenticated' | Persona;
const CALLERS: readonly Caller[] = ['unauthenticated', 'outsider', 'viewer', 'editor', 'owner'];

interface Row {
  readonly method: string;
  readonly path: (f: Fixture, ids: Record<string, string>) => string;
  readonly body?: () => unknown;
  /** Expected status for: unauthenticated, non-member, viewer, editor, owner. */
  readonly expect: readonly [number, number, number, number, number];
}

const slug = () => `s-${randomUUID().slice(0, 12)}`;

const ROWS: Record<string, Row> = {
  'POST /projects': {
    method: 'POST',
    path: () => '/projects',
    body: () => ({ name: 'P', slug: slug(), defaultLanguage: 'vi', timezone: 'UTC' }),
    expect: [401, 201, 201, 201, 201],
  },
  'GET /projects': { method: 'GET', path: () => '/projects', expect: [401, 200, 200, 200, 200] },
  'GET /projects/:projectId': {
    method: 'GET',
    path: (f) => `/projects/${f.projectId}`,
    expect: [401, 404, 200, 200, 200],
  },
  'PATCH /projects/:projectId': {
    method: 'PATCH',
    path: (f) => `/projects/${f.projectId}`,
    body: () => ({ name: 'Renamed' }),
    expect: [401, 404, 403, 403, 200],
  },
  'POST /projects/:projectId/archive': {
    method: 'POST',
    path: (f) => `/projects/${f.projectId}/archive`,
    expect: [401, 404, 403, 403, 200],
  },
  'GET /projects/:projectId/members': {
    method: 'GET',
    path: (f) => `/projects/${f.projectId}/members`,
    expect: [401, 404, 200, 200, 200],
  },
  'POST /projects/:projectId/members': {
    method: 'POST',
    path: (f) => `/projects/${f.projectId}/members`,
    body: () => ({ email: emailOf('invitee'), role: 'viewer' }),
    expect: [401, 404, 403, 403, 201],
  },
  'PATCH /projects/:projectId/members/:userId': {
    method: 'PATCH',
    path: (f, ids) => `/projects/${f.projectId}/members/${ids['target']}`,
    body: () => ({ role: 'viewer' }),
    expect: [401, 404, 403, 403, 200],
  },
  'DELETE /projects/:projectId/members/:userId': {
    method: 'DELETE',
    path: (f, ids) => `/projects/${f.projectId}/members/${ids['target']}`,
    expect: [401, 404, 403, 403, 204],
  },
  'POST /projects/:projectId/channels': {
    method: 'POST',
    path: (f) => `/projects/${f.projectId}/channels`,
    body: () => ({ name: 'C', slug: slug(), platform: 'tiktok' }),
    expect: [401, 404, 403, 201, 201],
  },
  'GET /projects/:projectId/channels': {
    method: 'GET',
    path: (f) => `/projects/${f.projectId}/channels`,
    expect: [401, 404, 200, 200, 200],
  },
  'GET /channels/:channelId': {
    method: 'GET',
    path: (f) => `/channels/${f.channelId}`,
    expect: [401, 404, 200, 200, 200],
  },
  'PATCH /channels/:channelId': {
    method: 'PATCH',
    path: (f) => `/channels/${f.channelId}`,
    body: () => ({ name: 'Renamed' }),
    expect: [401, 404, 403, 200, 200],
  },
  'POST /channels/:channelId/archive': {
    method: 'POST',
    path: (f) => `/channels/${f.channelId}/archive`,
    expect: [401, 404, 403, 200, 200],
  },
  'POST /projects/:projectId/content': {
    method: 'POST',
    path: (f) => `/projects/${f.projectId}/content`,
    body: () => newContent(),
    expect: [401, 404, 403, 201, 201],
  },
  'GET /projects/:projectId/content': {
    method: 'GET',
    path: (f) => `/projects/${f.projectId}/content`,
    expect: [401, 404, 200, 200, 200],
  },
  'GET /content/:contentId': {
    method: 'GET',
    path: (f) => `/content/${f.contentId}`,
    expect: [401, 404, 200, 200, 200],
  },
  'PATCH /content/:contentId': {
    method: 'PATCH',
    path: (f) => `/content/${f.contentId}`,
    body: () => ({ title: 'Renamed' }),
    expect: [401, 404, 403, 200, 200],
  },
  'POST /content/:contentId/archive': {
    method: 'POST',
    path: (f) => `/content/${f.contentId}/archive`,
    expect: [401, 404, 403, 200, 200],
  },
};

let api: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let ids: Record<string, string>;
let as: ReturnType<typeof actAs>;

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  api = await startAuthApp();
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe.each(Object.entries(ROWS))('%s', (_route, row) => {
  it.each(CALLERS.map((caller, i) => [caller, row.expect[i]] as const))(
    'as %s -> %i',
    async (caller, expected) => {
      const fixture = await createFixture(db, ids);
      const body = row.body?.();
      const res = await as(
        caller === 'unauthenticated' ? null : caller,
        row.method,
        row.path(fixture, ids),
        body === undefined ? {} : { body },
      );
      expect(res.status, JSON.stringify(res.json)).toBe(expected);
    },
  );
});
