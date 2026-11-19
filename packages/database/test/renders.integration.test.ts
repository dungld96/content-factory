// M6 renders under direct SQL, as the runtime role (M6 design §4, §9): what a render assembled is
// frozen; outputs, QC, the review and the export are each set once; a render is never deleted;
// the gate-5 pointer names an approved render of the same content item (AC017).
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
const RJ = '61000000-0000-7000-8000-000000000007'; // render job
const RJ2 = '61000000-0000-7000-8000-000000000008'; // render job of CI2
const S1 = '62000000-0000-7000-8000-000000000001';
const SB = '63000000-0000-7000-8000-000000000001';
const R = '66000000-0000-7000-8000-000000000001';
const R2 = '66000000-0000-7000-8000-000000000002'; // render of CI2
const VIDEO = '20000000-0000-7000-8000-0000000000e1';
const SRT = '20000000-0000-7000-8000-0000000000e2';
const THUMB = '20000000-0000-7000-8000-0000000000e3';
const KEY = 'a'.repeat(64);
const SUM = 'b'.repeat(64);

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const renderJob = (id: string, item: string) =>
  `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
     active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
     model_id, requested_by_id, updated_at)
   VALUES ('${id}', '${P}', '${item}', '${RUN}', 'render', 'queued', 0, '${item}:render', 'idem-${id}',
     '${KEY}', '{}', 'asset_review', 'render.v1', '${MODEL}', '${U}', now())`;
const output = (id: string, type: string, mime: string) =>
  `INSERT INTO assets (id, project_id, content_item_id, asset_type, source_type, storage_key, mime_type,
     size_bytes, checksum_sha256, generation_job_id, created_by_id, updated_at)
   VALUES ('${id}', '${P}', '${CI}', '${type}', 'generated', 'projects/${P}/assets/${id}/x', '${mime}', 10,
     '${SUM}', '${RJ}', '${U}', now())`;
const render = (id: string, item: string, job: string) =>
  `INSERT INTO renders (id, project_id, content_item_id, storyboard_version_id, generation_job_id, manifest,
     settings, execution_key, created_by_id, updated_at)
   VALUES ('${id}', '${P}', '${item}', '${SB}', '${job}', '{"scenes":[]}', '{"renderer":"render.v1"}', '${KEY}',
     '${U}', now())`;
const outputs = `UPDATE renders SET video_asset_id = '${VIDEO}', subtitle_asset_id = '${SRT}',
  thumbnail_asset_id = '${THUMB}', duration_ms = 30000, qc = '{"passed":true}' WHERE id = '${R}'`;
const approve = (id = R) =>
  `UPDATE renders SET review_status = 'approved', reviewed_by_id = '${U}', reviewed_at = now() WHERE id = '${id}'`;

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
     ${renderJob(RJ, CI)}; ${renderJob(RJ2, CI2)};
     ${output(VIDEO, 'render', 'video/mp4')}; ${output(SRT, 'subtitle', 'application/x-subrip')};
     ${output(THUMB, 'image', 'image/jpeg')};
     ${render(R, CI, RJ)}; ${render(R2, CI2, RJ2)};`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('render jobs', () => {
  it('are content-scoped: one active render per item, no scene', async () => {
    expect(await fails(renderJob('61000000-0000-7000-8000-000000000009', CI))).toBe('23505');
  });
});

describe('renders', () => {
  it('are created unreviewed and never deleted', async () => {
    expect(await fails(render('66000000-0000-7000-8000-000000000003', CI, RJ2))).not.toBeNull(); // the job belongs to another item (composite FK)
    expect(await fails(`DELETE FROM renders WHERE id = '${R}'`)).toBe('AC012');
  });

  it('freeze what was assembled and set outputs together, once', async () => {
    expect(await fails(`UPDATE renders SET manifest = '{"scenes":[1]}' WHERE id = '${R}'`)).toBe(
      'AC012',
    );
    expect(
      await fails(`UPDATE renders SET execution_key = '${'c'.repeat(64)}' WHERE id = '${R}'`),
    ).toBe('AC012');
    expect(await fails(`UPDATE renders SET video_asset_id = '${VIDEO}' WHERE id = '${R}'`)).toBe(
      '23514',
    );
    expect(await fails(outputs)).toBeNull();
    expect(
      await fails(`${outputs}; UPDATE renders SET duration_ms = 31000 WHERE id = '${R}'`),
    ).toBe('AC012');
  });

  it('are reviewed only with outputs, once; exported only when approved, once', async () => {
    expect(await fails(approve())).toBe('23514');
    expect(await fails(`${outputs}; ${approve()}`)).toBeNull();
    expect(
      await fails(`${outputs}; ${approve()};
        UPDATE renders SET review_status = 'rejected', review_note = 'no' WHERE id = '${R}'`),
    ).toBe('AC012');
    expect(
      await fails(
        `${outputs}; UPDATE renders SET exported_at = now(), exported_by_id = '${U}' WHERE id = '${R}'`,
      ),
    ).toBe('23514');
    expect(
      await fails(`${outputs}; ${approve()};
        UPDATE renders SET exported_at = now(), exported_by_id = '${U}' WHERE id = '${R}';
        UPDATE renders SET exported_at = now() + interval '1 day' WHERE id = '${R}'`),
    ).toBe('AC012');
  });
});

describe('gate 5 pointer (AC017)', () => {
  it('names an approved render of the same content item', async () => {
    const point = (item: string, id: string) =>
      `UPDATE content_items SET approved_render_id = '${id}' WHERE id = '${item}'`;
    expect(await fails(`${outputs}; ${point(CI, R)}`)).toBe('AC017'); // pending
    expect(await fails(`${outputs}; ${approve()}; ${point(CI, R)}`)).toBeNull();
    expect(await fails(`${outputs}; ${approve()}; ${point(CI2, R)}`)).toBe('23503'); // other item
  });

  it('accepts the clip, voice-over and music lineage roles', async () => {
    for (const role of ['clip', 'voiceover', 'music']) {
      expect(
        await fails(`INSERT INTO asset_inputs (project_id, asset_id, input_asset_id, role)
          VALUES ('${P}', '${VIDEO}', '${SRT}', '${role}')`),
        role,
      ).toBeNull();
    }
  });
});
