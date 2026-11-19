// M5 integrity layer under direct SQL, as the runtime role (M5 design §5–§8): video jobs record
// their submission once (decision V3), clip and voice-over selections are approved, active media
// of the scene's content item (AC016), and voice profiles are never deleted.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const U = '00000000-0000-7000-8000-000000000001';
const P = '10000000-0000-7000-8000-000000000001';
const CI = '40000000-0000-7000-8000-000000000001';
const CI2 = '40000000-0000-7000-8000-000000000002';
const PROV = '50000000-0000-7000-8000-000000000001';
const MODEL = '51000000-0000-7000-8000-000000000001';
const RUN = '60000000-0000-7000-8000-000000000001';
const TJ = '61000000-0000-7000-8000-000000000003';
const VID = '61000000-0000-7000-8000-000000000004'; // video job
const TTS = '61000000-0000-7000-8000-000000000005'; // TTS job
const INV = '65000000-0000-7000-8000-000000000001';
const INV2 = '65000000-0000-7000-8000-000000000002';
const S1 = '62000000-0000-7000-8000-000000000001';
const SB = '63000000-0000-7000-8000-000000000001';
const SC = '64000000-0000-7000-8000-000000000001';
const CLIP = '20000000-0000-7000-8000-0000000000c1';
const CLIP2 = '20000000-0000-7000-8000-0000000000c2';
const VO = '20000000-0000-7000-8000-0000000000d1'; // generated voice-over
const UPLOAD = '20000000-0000-7000-8000-0000000000d2'; // imported narration (no content item)
const FOREIGN = '20000000-0000-7000-8000-0000000000d3'; // upload of another content item
const VP = '70000000-0000-7000-8000-000000000001';
const KEY = 'a'.repeat(64);
const SUM = 'b'.repeat(64);

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const job = (id: string, kind: string, template: string) =>
  `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
     active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
     model_id, requested_by_id, storyboard_scene_id, updated_at)
   VALUES ('${id}', '${P}', '${CI}', '${RUN}', '${kind}', 'queued', 0, '${SC}:${kind}', 'idem-${id}',
     '${KEY}', '{}', 'storyboard_review', '${template}', '${MODEL}', '${U}', '${SC}', now())`;
const media = (id: string, type: 'video' | 'audio', o: Partial<Record<string, string>> = {}) => {
  const v = {
    item: `'${CI}'`,
    source: `'generated'`,
    job: type === 'video' ? `'${VID}'` : `'${TTS}'`,
    scene: `'${SC}'`,
    ...o,
  };
  const mime = type === 'video' ? 'video/mp4' : 'audio/mpeg';
  return `INSERT INTO assets (id, project_id, content_item_id, asset_type, source_type, storage_key, mime_type,
            size_bytes, checksum_sha256, generation_job_id, storyboard_scene_id, created_by_id, updated_at)
          VALUES ('${id}', '${P}', ${v.item}, '${type}', ${v.source}, 'projects/${P}/assets/${id}/x',
            '${mime}', 10, '${SUM}', ${v.job}, ${v.scene}, '${U}', now())`;
};
const approve = (id: string) =>
  `UPDATE assets SET approval_status = 'approved', reviewed_by_id = '${U}', reviewed_at = now() WHERE id = '${id}'`;
const select = (table: 'scene_clips' | 'scene_voiceovers', assetId: string) =>
  `INSERT INTO ${table} (storyboard_scene_id, project_id, asset_id, selected_by_id, selected_at)
     VALUES ('${SC}', '${P}', '${assetId}', '${U}', now())`;
const invocation = (id: string) =>
  `INSERT INTO ai_invocations (id, project_id, correlation_id, capability, provider_id, model_id, request_summary)
     VALUES ('${id}', '${P}', 'c', 'video_generation', '${PROV}', '${MODEL}', '{}')`;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await commit(
    app,
    `INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES ('${U}', 'u@example.test', 'U', 'x', now());
     INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
       VALUES ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES ('${P}', '${U}', 'owner', now());
     INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at) VALUES
       ('${CI}', '${P}', 'C', '{}', 'vi', '${U}', now()), ('${CI2}', '${P}', 'C2', '{}', 'vi', '${U}', now());
     INSERT INTO content_items (id, project_id, content_master_id, title, format, target_duration_seconds,
         aspect_ratio, language, brief, created_by_id, updated_at) VALUES
       ('${CI}', '${P}', '${CI}', 'C', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now()),
       ('${CI2}', '${P}', '${CI2}', 'C2', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now());
     INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES ('${PROV}', 'mock', 'M', 'mock', now());
     INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at)
       VALUES ('${MODEL}', '${PROV}', 'mock/x', 'X', 'economy', now());
     INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
       VALUES ('${RUN}', '${P}', '${CI}', '${U}', now());
     INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
         active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
         model_id, requested_by_id, updated_at)
       VALUES ('${TJ}', '${P}', '${CI}', '${RUN}', 'storyboard_generation', 'queued', 0,
         '${CI}:storyboard_generation', 'idem-tj', '${KEY}', '{}', 'script_review', 'storyboard.v1',
         '${MODEL}', '${U}', now());
     INSERT INTO script_versions (id, project_id, content_item_id, version, source, generation_job_id,
         schema_version, content)
       VALUES ('${S1}', '${P}', '${CI}', 1, 'generated', '${TJ}', 1, '{}');
     INSERT INTO storyboard_versions (id, project_id, content_item_id, script_version_id, version, source,
         generation_job_id, schema_version, total_duration_seconds)
       VALUES ('${SB}', '${P}', '${CI}', '${S1}', 1, 'generated', '${TJ}', 1, 30);
     INSERT INTO storyboard_scenes (id, project_id, storyboard_version_id, scene_number, duration_seconds, shot_type,
         camera_angle, camera_movement, character_action, visual_description, image_prompt, video_prompt,
         negative_prompt, voice_over_segment, on_screen_text)
       VALUES ('${SC}', '${P}', '${SB}', 1, 30, 'wide', 'eye', 'static', '', 'v', 'i', 'vid', '', 'vo', '');
     ${job(VID, 'video_generation', 'video.v1')};
     ${job(TTS, 'tts_generation', 'tts.v1')};
     ${invocation(INV)}; ${invocation(INV2)};
     ${media(CLIP, 'video')}; ${media(CLIP2, 'video')}; ${media(VO, 'audio')};
     ${media(UPLOAD, 'audio', { item: 'NULL', source: `'upload'`, job: 'NULL', scene: 'NULL' })};
     ${media(FOREIGN, 'audio', { item: `'${CI2}'`, source: `'upload'`, job: 'NULL', scene: 'NULL' })};
     ${approve(CLIP)}; ${approve(VO)}; ${approve(UPLOAD)}; ${approve(FOREIGN)};`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('video job submission (decision V3)', () => {
  it('keeps provider fields to video jobs and requires the intent with a provider job id', async () => {
    expect(
      await fails(`UPDATE generation_jobs SET status = 'running', attempt = 1, submitted_at = now(),
        invocation_id = '${INV}', provider_key = 'mock' WHERE id = '${TTS}'`),
    ).toBe('23514');
    expect(
      await fails(`UPDATE generation_jobs SET status = 'running', attempt = 1,
        provider_job_id = 'vid-1' WHERE id = '${VID}'`),
    ).toBe('23514');
  });

  it('lets a refused submit clear its intent, but freezes it once the provider job id is known', async () => {
    const start = `UPDATE generation_jobs SET status = 'running', attempt = 1, submitted_at = now(),
      invocation_id = '${INV}', provider_key = 'mock' WHERE id = '${VID}'`;
    expect(
      await fails(`${start};
        UPDATE generation_jobs SET submitted_at = NULL, invocation_id = NULL, provider_key = NULL WHERE id = '${VID}'`),
    ).toBeNull();
    const accepted = `${start}; UPDATE generation_jobs SET provider_job_id = 'vid-1' WHERE id = '${VID}'`;
    for (const change of [
      `provider_job_id = 'vid-2'`,
      `provider_job_id = NULL`,
      `invocation_id = '${INV2}'`,
      `submitted_at = now() + interval '1 minute'`,
      `provider_key = 'other'`,
    ]) {
      expect(
        await fails(`${accepted}; UPDATE generation_jobs SET ${change} WHERE id = '${VID}'`),
        change,
      ).toBe('AC011');
    }
    // Polls only move forward.
    expect(
      await fails(
        `${accepted}; UPDATE generation_jobs SET poll_count = 3, provider_status = 'in_progress' WHERE id = '${VID}'`,
      ),
    ).toBeNull();
    expect(
      await fails(`${accepted}; UPDATE generation_jobs SET poll_count = 3 WHERE id = '${VID}';
        UPDATE generation_jobs SET poll_count = 2 WHERE id = '${VID}'`),
    ).toBe('AC011');
  });

  it('records a provider job id at most once across jobs', async () => {
    expect(
      await fails(`UPDATE generation_jobs SET status = 'running', attempt = 1, submitted_at = now(),
          invocation_id = '${INV}', provider_key = 'mock', provider_job_id = 'dup' WHERE id = '${VID}';
        UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now() WHERE id = '${VID}';
        ${job('61000000-0000-7000-8000-000000000009', 'video_generation', 'video.v1')};
        UPDATE generation_jobs SET status = 'running', attempt = 1, submitted_at = now(),
          invocation_id = '${INV2}', provider_key = 'mock', provider_job_id = 'dup'
          WHERE id = '61000000-0000-7000-8000-000000000009'`),
    ).toBe('23505');
  });
});

describe('asset lineage', () => {
  it('accepts the keyframe role for clip inputs', async () => {
    expect(
      await fails(`INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role)
        VALUES ('${P}', '${CLIP}', '${UPLOAD}', 'keyframe')`),
    ).toBeNull();
    expect(
      await fails(`INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role)
        VALUES ('${P}', '${CLIP}', '${UPLOAD}', 'first_frame')`),
    ).toBe('23514');
  });
});

describe('scene clips and voice-overs (AC016)', () => {
  it('accepts only an approved, active video of the scene’s content item as the clip', async () => {
    expect(await fails(select('scene_clips', CLIP))).toBeNull();
    expect(await fails(select('scene_clips', CLIP2))).toBe('AC016'); // pending
    expect(await fails(select('scene_clips', VO))).toBe('AC016'); // audio
  });

  it('accepts a generated voice-over or imported narration, not another item’s file', async () => {
    expect(await fails(select('scene_voiceovers', VO))).toBeNull();
    expect(await fails(select('scene_voiceovers', UPLOAD))).toBeNull();
    expect(await fails(select('scene_voiceovers', FOREIGN))).toBe('AC016');
    expect(await fails(select('scene_voiceovers', CLIP))).toBe('AC016');
  });

  it('keeps a selected asset approved and unarchived, and the selection on its scene', async () => {
    expect(
      await fails(`${select('scene_clips', CLIP)};
        UPDATE assets SET approval_status = 'rejected' WHERE id = '${CLIP}'`),
    ).toBe('AC016');
    expect(
      await fails(`${select('scene_voiceovers', VO)};
        UPDATE assets SET archived_at = now() WHERE id = '${VO}'`),
    ).toBe('AC008');
    expect(
      await fails(`${select('scene_clips', CLIP)};
        UPDATE scene_clips SET project_id = '${P}', storyboard_scene_id = '${SB}' WHERE storyboard_scene_id = '${SC}'`),
    ).not.toBeNull();
  });

  it('allows clearing a selection (e.g. when the keyframe changes)', async () => {
    expect(
      await fails(
        `${select('scene_clips', CLIP)}; DELETE FROM scene_clips WHERE storyboard_scene_id = '${SC}'`,
      ),
    ).toBeNull();
  });

  it('keeps an append-only history with known reasons', async () => {
    const event = (reason: string) =>
      `INSERT INTO scene_clip_events (id, project_id, storyboard_scene_id, asset_id, selected_by_id, reason)
         VALUES (gen_random_uuid(), '${P}', '${SC}', '${CLIP}', '${U}', '${reason}')`;
    expect(await fails(event('selected'))).toBeNull();
    expect(await fails(event('guessed'))).toBe('23514');
    expect(await fails(`${event('cleared')}; DELETE FROM scene_clip_events`)).toBe('AC011');
  });
});

describe('voice profiles', () => {
  const profile = (o: Partial<Record<string, string>> = {}) => {
    const v = { name: `'Narrator'`, voice: `'alloy'`, language: `'vi'`, speed: 'NULL', ...o };
    return `INSERT INTO voice_profiles (id, project_id, name, model_id, voice, language, speed, created_by_id, updated_at)
      VALUES ('${VP}', '${P}', ${v.name}, '${MODEL}', ${v.voice}, ${v.language}, ${v.speed}, '${U}', now())`;
  };

  it('validates name, voice, language tag and speed', async () => {
    expect(await fails(profile({ language: `'vi-VN'`, speed: '1.25' }))).toBeNull();
    expect(await fails(profile({ name: `'  '` }))).toBe('23514');
    expect(await fails(profile({ voice: `''` }))).toBe('23514');
    expect(await fails(profile({ language: `'vietnamese!'` }))).toBe('23514');
    expect(await fails(profile({ speed: '2.5' }))).toBe('23514');
  });

  it('is archived, never deleted', async () => {
    expect(await fails(`${profile()}; DELETE FROM voice_profiles WHERE id = '${VP}'`)).toBe(
      'AC011',
    );
    expect(
      await fails(`${profile()}; UPDATE voice_profiles SET archived_at = now() WHERE id = '${VP}'`),
    ).toBeNull();
  });
});
