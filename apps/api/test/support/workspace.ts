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
  /** The content item's master (R0); same UUID as `contentId` in fixtures. */
  readonly contentMasterId: string;
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
    INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
      VALUES ('${contentId}', '${projectId}', 'Desk gadgets', '{"topic":"Desk gadgets"}', 'vi',
        '${ids['owner']}', now());
    INSERT INTO content_items (id, project_id, content_master_id, channel_id, title, format,
        target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at)
      VALUES ('${contentId}', '${projectId}', '${contentId}', '${channelId}', 'Desk gadgets', 'short_video',
        30, '9:16', 'vi', '{"topic":"Desk gadgets"}', '${ids['owner']}', now());
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
    contentMasterId: contentId,
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

export interface GenerationFixture {
  /** Generated script v1, approved and pointed to (gate 1). */
  readonly scriptId: string;
  /** Edited script v2, pending review. */
  readonly pendingScriptId: string;
  /** Storyboard v1 of the approved script, pending review, one 30 s scene. */
  readonly storyboardId: string;
  readonly sceneId: string;
  /** Succeeded run/job that generated the script. */
  readonly runId: string;
  readonly jobId: string;
}

/**
 * M3 rows on top of {@link createFixture} (needs the `mock/echo` model, e.g. from the AI seed):
 * content in `script_review` with an approved script, a pending edit, and a pending storyboard.
 */
export async function addGenerationFixture(
  db: pg.Client,
  ids: Record<string, string>,
  f: Fixture,
): Promise<GenerationFixture> {
  const [runId, jobId, scriptId, pendingScriptId, storyboardId, sceneId] = Array.from(
    { length: 6 },
    () => randomUUID(),
  ) as [string, string, string, string, string, string];
  const owner = ids['owner'] ?? '';
  await db.query(`BEGIN;
    INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
      VALUES ('${runId}', '${f.projectId}', '${f.contentId}', '${owner}', now());
    INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, active_key,
        idempotency_key, execution_key, input, previous_content_status, prompt_template_id, model_id,
        requested_by_id, updated_at)
      SELECT '${jobId}', '${f.projectId}', '${f.contentId}', '${runId}', 'script_generation',
        '${f.contentId}:script_generation', 'fx-${jobId}', repeat('e', 64), '{}', 'draft', 'script.v1', m.id,
        '${owner}', now()
      FROM ai_models m WHERE m.model_key = 'mock/echo';
    INSERT INTO script_versions (id, project_id, content_item_id, version, source, generation_job_id,
        schema_version, content)
      VALUES ('${scriptId}', '${f.projectId}', '${f.contentId}', 1, 'generated', '${jobId}', 1,
        '${JSON.stringify(SAMPLE_SCRIPT)}');
    UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, attempt = 1, completed_at = now(),
      result_script_version_id = '${scriptId}' WHERE id = '${jobId}';
    UPDATE production_runs SET status = 'succeeded', completed_at = now() WHERE id = '${runId}';
    UPDATE script_versions SET status = 'approved', reviewed_by_id = '${owner}', reviewed_at = now()
      WHERE id = '${scriptId}';
    INSERT INTO script_versions (id, project_id, content_item_id, version, source, based_on_version_id,
        schema_version, content, created_by_id)
      VALUES ('${pendingScriptId}', '${f.projectId}', '${f.contentId}', 2, 'edited', '${scriptId}', 1,
        '${JSON.stringify(SAMPLE_SCRIPT)}', '${owner}');
    UPDATE content_items SET status = 'script_review', approved_script_version_id = '${scriptId}'
      WHERE id = '${f.contentId}';
    INSERT INTO storyboard_versions (id, project_id, content_item_id, script_version_id, version, source,
        generation_job_id, schema_version, total_duration_seconds)
      VALUES ('${storyboardId}', '${f.projectId}', '${f.contentId}', '${scriptId}', 1, 'generated', '${jobId}', 1, 30);
    INSERT INTO storyboard_scenes (id, project_id, storyboard_version_id, scene_number, duration_seconds,
        shot_type, camera_angle, camera_movement, character_action, visual_description, image_prompt,
        video_prompt, negative_prompt, voice_over_segment, on_screen_text, acceptance_checks)
      VALUES ('${sceneId}', '${f.projectId}', '${storyboardId}', 1, 30, 'wide', 'eye level', 'static', '',
        'Desk', 'A desk', 'Push in', '', 'Hello', '', '{gadget visible}');
    COMMIT`);
  return { scriptId, pendingScriptId, storyboardId, sceneId, runId, jobId };
}

/** A schema-valid ScriptContent (content-domain `sampleScript`), as stored JSON. */
export const SAMPLE_SCRIPT = {
  title: '5 desk gadgets',
  plan: {
    angle: 'Small upgrades',
    audienceInsight: 'Afternoon slump',
    hookOptions: ['Your desk is stealing your energy'],
    keyMessage: 'Cheap upgrades help',
    callToAction: 'Follow',
    estimatedSceneCount: 1,
  },
  hook: 'Your desk is stealing your energy.',
  voiceOver: 'Here are five gadgets.',
  onScreenText: ['5 gadgets'],
  sceneOutline: [{ order: 1, summary: 'Gadgets', approxSeconds: 30 }],
  callToAction: 'Follow',
  claimsRequiringVerification: [],
  sources: [],
};
