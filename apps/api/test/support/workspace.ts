import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { UserAdminService } from '../../src/users/user-admin.service.js';
import { PASSWORD } from './auth-app.js';
import { client, CookieJar, type CallOptions, type CallResult } from './http-client.js';

export type Persona = 'owner' | 'editor' | 'viewer' | 'outsider';
export const PERSONAS: readonly Persona[] = ['owner', 'editor', 'viewer', 'outsider'];

export const emailOf = (who: Persona | 'target' | 'invitee') => `${who}@example.test`;

export interface Session {
  readonly jar: CookieJar;
  readonly csrf: string;
  readonly userId: string;
}

/** Creates the personas plus `target` (a member others act on) and `invitee` (never a member). */
export async function seedUsers(users: UserAdminService): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const who of [...PERSONAS, 'target', 'invitee'] as const) {
    ids[who] = (
      await users.create({ email: emailOf(who), displayName: who, password: PASSWORD })
    ).id;
  }
  return ids;
}

/** Signs in every persona once; `null` is the unauthenticated caller. */
export async function signInAll(baseUrl: string, ids: Record<string, string>) {
  const call = client(baseUrl);
  const sessions: Partial<Record<Persona, Session>> = {};
  for (const who of PERSONAS) {
    const jar = new CookieJar();
    const res = await call(jar, 'POST', '/auth/login', {
      body: { email: emailOf(who), password: PASSWORD },
    });
    if (res.status !== 200) throw new Error(`login failed for ${who}: ${res.status}`);
    sessions[who] = {
      jar,
      csrf: (res.json as { csrfToken: string }).csrfToken,
      userId: ids[who] ?? '',
    };
  }
  return sessions as Record<Persona, Session>;
}

/** Calls as a persona (with its CSRF token) or unauthenticated (`null`). */
export function actAs(baseUrl: string, sessions: Record<Persona, Session>) {
  const call = client(baseUrl);
  return (
    who: Persona | null,
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<CallResult> => {
    const session = who ? sessions[who] : null;
    return call(session?.jar ?? null, method, path, {
      ...options,
      headers: { ...(session ? { 'x-csrf-token': session.csrf } : {}), ...options.headers },
    });
  };
}

export interface Fixture {
  readonly projectId: string;
  readonly channelId: string;
  readonly contentId: string;
  /** Reference image used as the primary asset of both drafts. */
  readonly assetId: string;
  /** Unused asset (safe to link or archive). */
  readonly spareAssetId: string;
  readonly characterId: string;
  /** Draft v1 of the character. */
  readonly characterVersionId: string;
  readonly environmentId: string;
  /** Draft v1 of the environment. */
  readonly environmentVersionId: string;
}

/** `sha256`-shaped hex string for fixtures. */
export const fakeChecksum = (seed: string) =>
  Buffer.from(seed.padEnd(32, '0').slice(0, 32)).toString('hex');

/**
 * A fresh project via SQL (as the migrator): owner/editor/viewer personas plus `target`
 * (editor), one channel and one content item. `outsider` and `invitee` are not members.
 */
export async function createFixture(db: pg.Client, ids: Record<string, string>): Promise<Fixture> {
  const projectId = randomUUID();
  const channelId = randomUUID();
  const contentId = randomUUID();
  const [
    assetId,
    spareAssetId,
    characterId,
    characterVersionId,
    environmentId,
    environmentVersionId,
  ] = Array.from({ length: 6 }, () => randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const asset = (id: string, name: string) =>
    `('${id}', '${projectId}', 'reference', 'upload', 'projects/${projectId}/${name}.png', 'image/png', 1000,
      '${fakeChecksum(id)}', '${ids['owner']}', now())`;
  const slug = `p-${projectId.slice(0, 8)}`;
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Fixture', '${slug}', 'vi', 'Asia/Ho_Chi_Minh', '${ids['owner']}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
      ('${projectId}', '${ids['owner']}', 'owner', now()),
      ('${projectId}', '${ids['editor']}', 'editor', now()),
      ('${projectId}', '${ids['viewer']}', 'viewer', now()),
      ('${projectId}', '${ids['target']}', 'editor', now());
    INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
      VALUES ('${channelId}', '${projectId}', 'Main', 'main', 'tiktok', '${ids['owner']}', now());
    INSERT INTO content_items (id, project_id, channel_id, title, format, target_duration_seconds,
        aspect_ratio, language, brief, created_by_id, updated_at)
      VALUES ('${contentId}', '${projectId}', '${channelId}', 'Desk gadgets', 'short_video', 30, '9:16',
        'vi', '{"topic":"Desk gadgets"}', '${ids['owner']}', now());
    INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes,
        checksum_sha256, created_by_id, updated_at)
      VALUES ${asset(assetId, 'front')}, ${asset(spareAssetId, 'spare')};
    INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at)
      VALUES ('${characterId}', '${projectId}', 'Khánh', 'khanh', '${ids['owner']}', now());
    INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id,
        created_by_id, updated_at)
      VALUES ('${characterVersionId}', '${projectId}', '${characterId}', 1, 'v1', '${assetId}', '${ids['owner']}', now());
    INSERT INTO environments (id, project_id, name, slug, created_by_id, updated_at)
      VALUES ('${environmentId}', '${projectId}', 'Office', 'office', '${ids['owner']}', now());
    INSERT INTO environment_versions (id, project_id, environment_id, version, description, primary_asset_id,
        created_by_id, updated_at)
      VALUES ('${environmentVersionId}', '${projectId}', '${environmentId}', 1, 'v1', '${assetId}', '${ids['owner']}', now());
    COMMIT`);
  return {
    projectId,
    channelId,
    contentId,
    assetId,
    spareAssetId,
    characterId,
    characterVersionId,
    environmentId,
    environmentVersionId,
  };
}

export const validBrief = { topic: 'Useful desk gadgets', audience: 'Office workers' };
export const newContent = (channelId?: string) => ({
  title: '5 useful desk gadgets',
  ...(channelId ? { channelId } : {}),
  format: 'short_video',
  targetDurationSeconds: 30,
  aspectRatio: '9:16',
  language: 'vi',
  brief: validBrief,
});

/** A valid asset registration body for `projectId`. */
export const newAsset = (projectId: string, extra: Record<string, unknown> = {}) => {
  const id = randomUUID();
  return {
    assetType: 'reference',
    sourceType: 'upload',
    storageKey: `projects/${projectId}/uploads/${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 123_456,
    checksumSha256: fakeChecksum(id),
    width: 1080,
    height: 1920,
    originalFilename: 'front.png',
    ...extra,
  };
};
