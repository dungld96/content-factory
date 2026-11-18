// M4 integrity layer under direct SQL, as the runtime role (M4 design §4.4, §5): image jobs are
// scene-scoped, generated assets link their job, lineage is append-only, and a scene keyframe is
// an approved, active image of the scene's own content item (AC015).
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
const TXT = '61000000-0000-7000-8000-000000000001';
const IMG = '61000000-0000-7000-8000-000000000002';
const TJ = '61000000-0000-7000-8000-000000000003'; // the text job that generated script and storyboard
const S1 = '62000000-0000-7000-8000-000000000001';
const SB = '63000000-0000-7000-8000-000000000001';
const SC = '64000000-0000-7000-8000-000000000001';
const REF = '20000000-0000-7000-8000-000000000001';
const A1 = '20000000-0000-7000-8000-0000000000a1';
const A2 = '20000000-0000-7000-8000-0000000000a2';
const OTHER = '20000000-0000-7000-8000-0000000000b1'; // image of another content item
const KEY = 'a'.repeat(64);
const SUM = 'b'.repeat(64);

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const imageJob = (id: string, o: Partial<Record<string, string>> = {}) => {
  const v = {
    kind: `'image_generation'`,
    scene: `'${SC}'`,
    active_key: `'${SC}:image_generation'`,
    status: `'queued'`,
    ...o,
  };
  return `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
            active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
            model_id, requested_by_id, storyboard_scene_id, updated_at)
          VALUES ('${id}', '${P}', '${CI}', '${RUN}', ${v.kind}, ${v.status}, 0, ${v.active_key}, 'idem-${id}',
            '${KEY}', '{}', 'storyboard_review', 'image.v1', '${MODEL}', '${U}', ${v.scene}, now())`;
};
const asset = (id: string, o: Partial<Record<string, string>> = {}) => {
  const v = {
    item: `'${CI}'`,
    source: `'generated'`,
    job: `'${IMG}'`,
    scene: `'${SC}'`,
    type: `'image'`,
    ...o,
  };
  return `INSERT INTO assets (id, project_id, content_item_id, asset_type, source_type, storage_key, mime_type,
            size_bytes, checksum_sha256, generation_job_id, storyboard_scene_id, created_by_id, updated_at)
          VALUES ('${id}', '${P}', ${v.item}, ${v.type}, ${v.source}, 'projects/${P}/assets/${id}/x.png',
            'image/png', 10, '${SUM}', ${v.job}, ${v.scene}, '${U}', now())`;
};
const approve = (id: string) =>
  `UPDATE assets SET approval_status = 'approved', reviewed_by_id = '${U}', reviewed_at = now() WHERE id = '${id}'`;
const keyframe = (assetId: string) =>
  `INSERT INTO scene_keyframes (storyboard_scene_id, project_id, asset_id, selected_by_id, selected_at)
     VALUES ('${SC}', '${P}', '${assetId}', '${U}', now())`;

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
       VALUES ('${SC}', '${P}', '${SB}', 1, 30, 'wide', 'eye', 'static', '', 'v', 'i', 'vid', '', '', '');
     ${imageJob(IMG)};
     INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes,
         checksum_sha256, created_by_id, updated_at)
       VALUES ('${REF}', '${P}', 'reference', 'upload', 'projects/${P}/r.png', 'image/png', 10, '${SUM}', '${U}', now());
     ${asset(A1)}; ${asset(A2)};
     ${asset(OTHER, { item: `'${CI2}'`, scene: 'NULL' })};`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('image jobs (scene-scoped)', () => {
  it('requires a scene for image jobs and none for text jobs', async () => {
    expect(
      await fails(imageJob(TXT, { scene: 'NULL', active_key: `NULL`, status: `'queued'` })),
    ).toBe('23514');
    expect(
      await fails(`INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status,
          attempt, active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
          model_id, requested_by_id, storyboard_scene_id, updated_at)
        VALUES ('${TXT}', '${P}', '${CI}', '${RUN}', 'script_generation', 'queued', 0, '${CI}:script_generation',
          'i-t', '${KEY}', '{}', 'draft', 'script.v1', '${MODEL}', '${U}', '${SC}', now())`),
    ).toBe('23514');
  });

  it('keys the active image job by scene: one active job per scene', async () => {
    expect(await fails(imageJob(TXT, { active_key: `'${CI}:image_generation'` }))).toBe('23514');
    expect(await fails(imageJob(TXT))).toBe('23505'); // the seeded job is active for that scene
  });

  it('lets an image job succeed without a result version, and keeps its scene immutable', async () => {
    expect(
      await fails(`UPDATE generation_jobs SET status = 'running', attempt = 1, started_at = now() WHERE id = '${IMG}';
        UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now() WHERE id = '${IMG}'`),
    ).toBeNull();
    expect(
      await fails(
        `UPDATE generation_jobs SET storyboard_scene_id = NULL, kind = 'image_generation' WHERE id = '${IMG}'`,
      ),
    ).toBe('AC011');
  });
});

describe('generated assets', () => {
  it('link their job iff generated; scenes only for generated assets', async () => {
    const X = '20000000-0000-7000-8000-0000000000c1';
    expect(await fails(asset(X, { job: 'NULL' }))).toBe('23514');
    expect(await fails(asset(X, { source: `'upload'`, scene: 'NULL' }))).toBe('23514');
    expect(await fails(asset(X, { source: `'upload'`, job: 'NULL' }))).toBe('23514'); // scene set
  });

  it('keep job and scene links immutable (AC005)', async () => {
    expect(await fails(`UPDATE assets SET storyboard_scene_id = NULL WHERE id = '${A1}'`)).toBe(
      'AC005',
    );
    expect(await fails(`UPDATE assets SET generation_job_id = NULL WHERE id = '${A1}'`)).toBe(
      'AC005',
    );
  });

  it('record a reviewer with a review time, both or neither', async () => {
    expect(await fails(`UPDATE assets SET reviewed_at = now() WHERE id = '${A1}'`)).toBe('23514');
  });
});

describe('asset lineage (asset_inputs)', () => {
  it('records inputs once and never changes them', async () => {
    await commit(
      app,
      `INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role) VALUES ('${P}', '${A1}', '${REF}', 'character')`,
    );
    expect(
      await fails(`UPDATE asset_inputs SET role = 'environment' WHERE asset_id = '${A1}'`),
    ).toBe('AC005');
    expect(await fails(`DELETE FROM asset_inputs WHERE asset_id = '${A1}'`)).toBe('AC005');
    expect(
      await fails(
        `INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role) VALUES ('${P}', '${A1}', '${A1}', 'character')`,
      ),
    ).toBe('23514');
    expect(
      await fails(
        `INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role) VALUES ('${P}', '${A2}', '${REF}', 'style')`,
      ),
    ).toBe('23514');
  });
});

describe('scene keyframes (AC015)', () => {
  it('accepts only an approved, active image of the scene’s content item', async () => {
    expect(await fails(keyframe(A1))).toBe('AC015'); // pending
    await commit(app, `${approve(A1)}; ${approve(OTHER)}`);
    expect(await fails(keyframe(OTHER))).toBe('AC015'); // another content item
    expect(await fails(keyframe(REF))).toBe('AC015'); // not an image
    await commit(app, keyframe(A1));
  });

  it('moves to another approved candidate, never deletes, never changes scene', async () => {
    expect(
      await fails(
        `UPDATE scene_keyframes SET asset_id = '${A2}' WHERE storyboard_scene_id = '${SC}'`,
      ),
    ).toBe('AC015'); // A2 is still pending
    await commit(app, approve(A2));
    expect(
      await fails(
        `UPDATE scene_keyframes SET asset_id = '${A2}' WHERE storyboard_scene_id = '${SC}'`,
      ),
    ).toBeNull();
    expect(await fails(`DELETE FROM scene_keyframes WHERE storyboard_scene_id = '${SC}'`)).toBe(
      'AC015',
    );
  });

  it('keeps the keyframe asset approved and unarchived', async () => {
    expect(await fails(`UPDATE assets SET approval_status = 'rejected' WHERE id = '${A1}'`)).toBe(
      'AC015',
    );
    expect(await fails(`UPDATE assets SET archived_at = now() WHERE id = '${A1}'`)).toBe('AC008');
    // A2 is not the keyframe: it can be rejected.
    expect(
      await fails(`UPDATE assets SET approval_status = 'rejected' WHERE id = '${A2}'`),
    ).toBeNull();
  });

  it('keeps an append-only selection history', async () => {
    await commit(
      app,
      `INSERT INTO scene_keyframe_events (id, project_id, storyboard_scene_id, asset_id, selected_by_id, reason)
         VALUES (gen_random_uuid(), '${P}', '${SC}', '${A1}', '${U}', 'selected')`,
    );
    expect(await fails(`UPDATE scene_keyframe_events SET reason = 'reused'`)).toBe('AC011');
    expect(
      await fails(`INSERT INTO scene_keyframe_events (id, project_id, storyboard_scene_id, asset_id, selected_by_id, reason)
         VALUES (gen_random_uuid(), '${P}', '${SC}', '${A1}', '${U}', 'auto')`),
    ).toBe('23514');
  });
});
