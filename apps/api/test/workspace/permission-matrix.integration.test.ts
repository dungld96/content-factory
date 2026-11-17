// Table-driven permission matrix (design package §8.2). Every row runs for every caller:
// unauthenticated, non-member, viewer, editor, owner. Each call gets a fresh fixture project, so
// destructive successes never affect another cell. The table must cover every registered route
// (asserted below); only the auth, health and OpenAPI routes are exempt (tested separately).
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
import { OpenApiService } from '../../src/openapi/openapi.service.js';
import {
  actAs,
  createFixture,
  emailOf,
  newAsset,
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
  readonly body?: (f: Fixture) => unknown;
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
  ...versionedRows('characters', 'characterId', 'character-versions', (f) => [
    f.characterId,
    f.characterVersionId,
  ]),
  ...versionedRows('environments', 'environmentId', 'environment-versions', (f) => [
    f.environmentId,
    f.environmentVersionId,
  ]),
  'POST /projects/:projectId/assets': {
    method: 'POST',
    path: (f) => `/projects/${f.projectId}/assets`,
    body: (f) => newAsset(f.projectId),
    expect: [401, 404, 403, 201, 201],
  },
  'GET /projects/:projectId/assets': {
    method: 'GET',
    path: (f) => `/projects/${f.projectId}/assets`,
    expect: [401, 404, 200, 200, 200],
  },
  'GET /assets/:assetId': {
    method: 'GET',
    path: (f) => `/assets/${f.assetId}`,
    expect: [401, 404, 200, 200, 200],
  },
  'GET /assets/:assetId/lineage': {
    method: 'GET',
    path: (f) => `/assets/${f.assetId}/lineage`,
    expect: [401, 404, 200, 200, 200],
  },
  'GET /assets/:assetId/usages': {
    method: 'GET',
    path: (f) => `/assets/${f.assetId}/usages`,
    expect: [401, 404, 200, 200, 200],
  },
  'PATCH /assets/:assetId': {
    method: 'PATCH',
    path: (f) => `/assets/${f.assetId}`,
    body: () => ({ label: 'front view' }),
    expect: [401, 404, 403, 200, 200],
  },
  'POST /assets/:assetId/archive': {
    method: 'POST',
    path: (f) => `/assets/${f.spareAssetId}/archive`,
    expect: [401, 404, 403, 200, 200],
  },
};

/** The same eleven rows for characters and environments (design package §8.2). */
function versionedRows(
  plural: string,
  idParam: string,
  versions: string,
  ids: (f: Fixture) => [string, string],
): Record<string, Row> {
  const parent = (f: Fixture) => ids(f)[0];
  const draft = (f: Fixture) => ids(f)[1];
  return {
    [`POST /projects/:projectId/${plural}`]: {
      method: 'POST',
      path: (f) => `/projects/${f.projectId}/${plural}`,
      body: () => ({ name: 'N', slug: slug() }),
      expect: [401, 404, 403, 201, 201],
    },
    [`GET /projects/:projectId/${plural}`]: {
      method: 'GET',
      path: (f) => `/projects/${f.projectId}/${plural}`,
      expect: [401, 404, 200, 200, 200],
    },
    [`GET /${plural}/:${idParam}`]: {
      method: 'GET',
      path: (f) => `/${plural}/${parent(f)}`,
      expect: [401, 404, 200, 200, 200],
    },
    [`PATCH /${plural}/:${idParam}`]: {
      method: 'PATCH',
      path: (f) => `/${plural}/${parent(f)}`,
      body: () => ({ name: 'Renamed' }),
      expect: [401, 404, 403, 200, 200],
    },
    [`POST /${plural}/:${idParam}/archive`]: {
      method: 'POST',
      path: (f) => `/${plural}/${parent(f)}/archive`,
      expect: [401, 404, 403, 200, 200],
    },
    [`POST /${plural}/:${idParam}/versions`]: {
      method: 'POST',
      path: (f) => `/${plural}/${parent(f)}/versions`,
      body: () => ({ description: 'v2' }),
      expect: [401, 404, 403, 201, 201],
    },
    [`GET /${plural}/:${idParam}/versions`]: {
      method: 'GET',
      path: (f) => `/${plural}/${parent(f)}/versions`,
      expect: [401, 404, 200, 200, 200],
    },
    [`GET /${versions}/:versionId`]: {
      method: 'GET',
      path: (f) => `/${versions}/${draft(f)}`,
      expect: [401, 404, 200, 200, 200],
    },
    [`PATCH /${versions}/:versionId`]: {
      method: 'PATCH',
      path: (f) => `/${versions}/${draft(f)}`,
      body: () => ({ description: 'edited' }),
      expect: [401, 404, 403, 200, 200],
    },
    [`PUT /${versions}/:versionId/assets`]: {
      method: 'PUT',
      path: (f) => `/${versions}/${draft(f)}/assets`,
      body: (f) => ({ assets: [{ assetId: f.spareAssetId }] }),
      expect: [401, 404, 403, 200, 200],
    },
    [`POST /${versions}/:versionId/approve`]: {
      method: 'POST',
      path: (f) => `/${versions}/${draft(f)}/approve`,
      expect: [401, 404, 403, 200, 200],
    },
  };
}

/** Routes covered by their own suites (auth, health, OpenAPI), not by the role matrix. */
const EXEMPT = new Set([
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth/me',
  'GET /auth/csrf',
  'GET /health',
  'GET /health/ready',
  'GET /openapi.json',
]);

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
      const body = row.body?.(fixture);
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

it('covers every registered route (design package §8.2 test obligation)', () => {
  const registered = api.app
    .get(OpenApiService)
    .routes()
    .filter((r) => !r.path.startsWith('/test-'))
    .map((r) => `${r.method.toUpperCase()} ${r.path}`);
  const missing = registered.filter((key) => !(key in ROWS) && !EXEMPT.has(key));
  const stale = Object.keys(ROWS).filter((key) => !registered.includes(key));
  expect({ missing, stale }).toEqual({ missing: [], stale: [] });
});
