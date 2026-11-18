// M3 integrity layer under direct SQL (M3 design package §4.3, ADR-0013), as the runtime role
// acf_app: generation jobs/runs/events, immutable script and storyboard versions, scenes, and
// the approval pointers on content items. Tests run in file order and build on committed state.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const U = '00000000-0000-7000-8000-000000000001';
const P = '10000000-0000-7000-8000-000000000001';
const P2 = '10000000-0000-7000-8000-000000000002';
const CI = '40000000-0000-7000-8000-000000000001';
const CI2 = '40000000-0000-7000-8000-000000000002'; // same project, another item
const CI9 = '40000000-0000-7000-8000-000000000009'; // project P2
const A1 = '20000000-0000-7000-8000-000000000001';
const A9 = '20000000-0000-7000-8000-000000000009'; // project P2
const CH = '30000000-0000-7000-8000-000000000001';
const CV = '31000000-0000-7000-8000-000000000001';
const PROV = '50000000-0000-7000-8000-000000000001';
const MODEL = '51000000-0000-7000-8000-000000000001';
const RUN = '60000000-0000-7000-8000-000000000001';
const JOB = '61000000-0000-7000-8000-000000000001';
const S1 = '62000000-0000-7000-8000-000000000001';
const S2 = '62000000-0000-7000-8000-000000000002';
const S3 = '62000000-0000-7000-8000-000000000003';
const SB1 = '63000000-0000-7000-8000-000000000001';
const SB2 = '63000000-0000-7000-8000-000000000002';
const SC1 = '64000000-0000-7000-8000-000000000001';
const KEY = 'a'.repeat(64);

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const job = (id: string, o: Partial<Record<string, string>> = {}) => {
  const v = {
    content_item_id: `'${CI}'`,
    kind: `'script_generation'`,
    status: `'queued'`,
    attempt: '0',
    active_key: `'${CI}:script_generation'`,
    idempotency_key: `'idem-${id}'`,
    execution_key: `'${KEY}'`,
    input: `'{}'`,
    ...o,
  };
  return `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, status, attempt,
            active_key, idempotency_key, execution_key, input, previous_content_status, prompt_template_id,
            model_id, requested_by_id, updated_at)
          VALUES ('${id}', '${P}', ${v.content_item_id}, '${RUN}', ${v.kind}, ${v.status}, ${v.attempt},
            ${v.active_key}, ${v.idempotency_key}, ${v.execution_key}, ${v.input}, 'draft', 'script.v1',
            '${MODEL}', '${U}', now())`;
};
const script = (id: string, version: number, o: Partial<Record<string, string>> = {}) => {
  const v = {
    content_item_id: `'${CI}'`,
    status: `'pending_review'`,
    source: `'edited'`,
    based_on: `'${S1}'`,
    job: 'NULL',
    created_by: `'${U}'`,
    content: `'{"title":"t"}'`,
    ...o,
  };
  return `INSERT INTO script_versions (id, project_id, content_item_id, version, status, source, based_on_version_id,
            generation_job_id, schema_version, content, created_by_id)
          VALUES ('${id}', '${P}', ${v.content_item_id}, ${String(version)}, ${v.status}, ${v.source}, ${v.based_on},
            ${v.job}, 1, ${v.content}, ${v.created_by})`;
};
const review = (table: string, id: string, status: string, note = 'NULL') =>
  `UPDATE ${table} SET status = '${status}', reviewed_by_id = '${U}', reviewed_at = now(), review_note = ${note} WHERE id = '${id}'`;
const storyboard = (id: string, version: number, scriptId: string, basedOn: string | null = null) =>
  `INSERT INTO storyboard_versions (id, project_id, content_item_id, script_version_id, version, source, based_on_version_id,
     generation_job_id, schema_version, total_duration_seconds, created_by_id)
   VALUES ('${id}', '${P}', '${CI}', '${scriptId}', ${String(version)}, ${basedOn ? "'edited'" : "'generated'"},
     ${basedOn ? `'${basedOn}'` : 'NULL'}, ${basedOn ? 'NULL' : `'${JOB}'`}, 1, 30, ${basedOn ? `'${U}'` : 'NULL'})`;
const scene = (id: string, sbId: string, n: number, o: Partial<Record<string, string>> = {}) => {
  const v = { project: `'${P}'`, cv: 'NULL', duration: '6', ...o };
  return `INSERT INTO storyboard_scenes (id, project_id, storyboard_version_id, scene_number, duration_seconds, shot_type,
            camera_angle, camera_movement, character_action, character_version_id, visual_description, image_prompt,
            video_prompt, negative_prompt, voice_over_segment, on_screen_text)
          VALUES ('${id}', ${v.project}, '${sbId}', ${String(n)}, ${v.duration}, 'wide', 'eye', 'static', '', ${v.cv},
            'v', 'i', 'vid', '', '', '')`;
};

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await app.query(`INSERT INTO users (id, email, display_name, password_hash, updated_at)
    VALUES ('${U}', 'o@example.test', 'O', 'x', now())`);
  await commit(
    app,
    `INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at) VALUES
       ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now()), ('${P2}', 'P2', 'p2', 'vi', 'UTC', '${U}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
       ('${P}', '${U}', 'owner', now()), ('${P2}', '${U}', 'owner', now())`,
  );
  await app.query(`INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id,
      updated_at) VALUES
    ('${CI}', '${P}', 'C', '{}', 'vi', '${U}', now()),
    ('${CI2}', '${P}', 'C2', '{}', 'vi', '${U}', now()),
    ('${CI9}', '${P2}', 'C9', '{}', 'vi', '${U}', now())`);
  await app.query(`INSERT INTO content_items (id, project_id, content_master_id, title, format,
      target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at) VALUES
    ('${CI}', '${P}', '${CI}', 'C', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now()),
    ('${CI2}', '${P}', '${CI2}', 'C2', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now()),
    ('${CI9}', '${P2}', '${CI9}', 'C9', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now())`);
  await app.query(`INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes,
      checksum_sha256, created_by_id, updated_at) VALUES
    ('${A1}', '${P}', 'reference', 'upload', 'p/a1', 'image/png', 1, repeat('a', 64), '${U}', now()),
    ('${A9}', '${P2}', 'reference', 'upload', 'p2/a9', 'image/png', 1, repeat('b', 64), '${U}', now())`);
  await app.query(`INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at)
    VALUES ('${CH}', '${P}', 'K', 'k', '${U}', now())`);
  await app.query(`INSERT INTO character_versions (id, project_id, character_id, version, description, created_by_id, updated_at)
    VALUES ('${CV}', '${P}', '${CH}', 1, 'd', '${U}', now())`);
  await app.query(
    `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES ('${PROV}', 'mock', 'M', 'mock', now())`,
  );
  await app.query(`INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at)
    VALUES ('${MODEL}', '${PROV}', 'mock/echo', 'Echo', 'economy', now())`);
  await app.query(`INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
    VALUES ('${RUN}', '${P}', '${CI}', '${U}', now())`);
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('generation jobs', () => {
  it('accepts a queued job at attempt 0', async () => {
    await app.query(job(JOB));
    expect(
      (await app.query(`SELECT status FROM generation_jobs WHERE id = '${JOB}'`)).rows[0],
    ).toEqual({ status: 'queued' });
  });

  it.each([
    [
      'inserted running',
      job('61000000-0000-7000-8000-0000000000a1', { status: `'running'`, idempotency_key: `'x1'` }),
      'AC011',
    ],
    [
      'inserted at attempt 1',
      job('61000000-0000-7000-8000-0000000000a2', {
        attempt: '1',
        active_key: 'NULL',
        idempotency_key: `'x2'`,
      }),
      'AC011',
    ],
    [
      'a second active job for the same item and kind',
      job('61000000-0000-7000-8000-0000000000a3', { idempotency_key: `'x3'` }),
      '23505',
    ],
    [
      'an active job without its active key',
      job('61000000-0000-7000-8000-0000000000a4', { active_key: 'NULL', idempotency_key: `'x4'` }),
      '23514',
    ],
    [
      'a wrong active key',
      job('61000000-0000-7000-8000-0000000000a5', {
        active_key: `'${CI2}:script_generation'`,
        idempotency_key: `'x5'`,
      }),
      '23514',
    ],
    [
      'a duplicate idempotency key',
      job('61000000-0000-7000-8000-0000000000a6', {
        idempotency_key: `'idem-${JOB}'`,
        content_item_id: `'${CI2}'`,
        active_key: `'${CI2}:script_generation'`,
      }),
      '23505',
    ],
    [
      'a malformed execution key',
      job('61000000-0000-7000-8000-0000000000a7', {
        execution_key: `'abc'`,
        idempotency_key: `'x7'`,
        content_item_id: `'${CI2}'`,
        active_key: `'${CI2}:script_generation'`,
      }),
      '23514',
    ],
    [
      'a content item of another project',
      job('61000000-0000-7000-8000-0000000000a8', {
        content_item_id: `'${CI9}'`,
        active_key: `'${CI9}:script_generation'`,
        idempotency_key: `'x8'`,
      }),
      '23503',
    ],
  ])('rejects %s', async (_n, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('allows another kind for the same item while one is active', async () => {
    expect(
      await fails(
        job('61000000-0000-7000-8000-0000000000b1', {
          kind: `'storyboard_generation'`,
          active_key: `'${CI}:storyboard_generation'`,
          idempotency_key: `'y1'`,
        }),
      ),
    ).toBeNull();
  });

  it('moves to running and records the prompt snapshot once', async () => {
    await app.query(
      `UPDATE generation_jobs SET status = 'running', attempt = 1, started_at = now(), prompt_snapshot = 'P' WHERE id = '${JOB}'`,
    );
    expect(
      await fails(`UPDATE generation_jobs SET prompt_snapshot = 'Q' WHERE id = '${JOB}'`),
    ).toBe('AC011');
  });

  it.each([
    [
      'succeeded without a result',
      `UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now() WHERE id = '${JOB}'`,
      '23514',
    ],
    [
      'failed without an error code',
      `UPDATE generation_jobs SET status = 'failed', active_key = NULL, completed_at = now() WHERE id = '${JOB}'`,
      '23514',
    ],
    [
      'terminal while keeping the active key',
      `UPDATE generation_jobs SET status = 'failed', error_code = 'X', completed_at = now() WHERE id = '${JOB}'`,
      '23514',
    ],
    [
      'attempt above the maximum',
      `UPDATE generation_jobs SET attempt = 4 WHERE id = '${JOB}'`,
      '23514',
    ],
    ['attempt decreasing', `UPDATE generation_jobs SET attempt = 0 WHERE id = '${JOB}'`, 'AC011'],
    [
      'identity change (execution key)',
      `UPDATE generation_jobs SET execution_key = '${'b'.repeat(64)}' WHERE id = '${JOB}'`,
      'AC011',
    ],
    [
      'identity change (input)',
      `UPDATE generation_jobs SET input = '{"x":1}' WHERE id = '${JOB}'`,
      'AC011',
    ],
    ['delete', `DELETE FROM generation_jobs WHERE id = '${JOB}'`, 'AC011'],
  ])('rejects %s', async (_n, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('job events are append-only; runs keep their identity and are never deleted', async () => {
    await app.query(`INSERT INTO job_events (id, project_id, job_id, from_status, to_status, attempt, detail)
      VALUES (gen_random_uuid(), '${P}', '${JOB}', 'queued', 'running', 1, '{"type":"started"}')`);
    expect(await fails(`UPDATE job_events SET attempt = 2`)).toBe('AC011');
    expect(await fails(`DELETE FROM job_events`)).toBe('AC011');
    expect(
      await fails(
        `INSERT INTO job_events (id, project_id, job_id, to_status, attempt, detail) VALUES (gen_random_uuid(), '${P2}', '${JOB}', 'running', 1, '{}')`,
      ),
    ).toBe('23503');
    expect(await fails(`DELETE FROM production_runs WHERE id = '${RUN}'`)).toBe('AC011');
    expect(
      await fails(
        `UPDATE production_runs SET requested_by_id = '${U}', created_at = now() WHERE id = '${RUN}'`,
      ),
    ).toBe('AC011');
    expect(await fails(`UPDATE production_runs SET status = 'succeeded' WHERE id = '${RUN}'`)).toBe(
      '23514',
    );
  });
});

describe('script versions (AC012)', () => {
  it('stores a generated version linked to its job', async () => {
    await app.query(
      script(S1, 1, {
        source: `'generated'`,
        based_on: 'NULL',
        job: `'${JOB}'`,
        created_by: 'NULL',
      }),
    );
  });

  it.each([
    ['inserted approved', script(S2, 2, { status: `'approved'` }), 'AC012'],
    [
      'generated without a job',
      script(S2, 2, { source: `'generated'`, based_on: 'NULL' }),
      '23514',
    ],
    ['edited without a base version', script(S2, 2, { based_on: 'NULL' }), '23514'],
    ['edited without an author', script(S2, 2, { created_by: 'NULL' }), '23514'],
    ['based on a version of another item', script(S2, 1, { content_item_id: `'${CI2}'` }), '23503'],
    ['a duplicate version number', script(S2, 1), '23505'],
    ['content that is not an object', script(S2, 2, { content: `'[]'` }), '23514'],
  ])('rejects a version %s', async (_n, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it.each([
    [
      'changing pending content',
      `UPDATE script_versions SET content = '{"title":"x"}' WHERE id = '${S1}'`,
    ],
    ['a note without a review', `UPDATE script_versions SET review_note = 'n' WHERE id = '${S1}'`],
    ['deleting', `DELETE FROM script_versions WHERE id = '${S1}'`],
  ])('rejects %s', async (_n, sql) => {
    expect(await fails(sql)).toBe('AC012');
  });

  it('completes the succeeded job and reviews once', async () => {
    await app.query(`UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now(),
      result_script_version_id = '${S1}' WHERE id = '${JOB}'`);
    expect(
      await fails(`UPDATE generation_jobs SET error_message = 'late' WHERE id = '${JOB}'`),
    ).toBe('AC011');
    expect(
      await fails(
        `UPDATE script_versions SET status = 'approved', reviewed_at = now() WHERE id = '${S1}'`,
      ),
    ).toBe('23514');
    await app.query(review('script_versions', S1, 'approved'));
    expect(await fails(review('script_versions', S1, 'rejected'))).toBe('AC012');
    expect(await fails(`UPDATE script_versions SET content = '{}' WHERE id = '${S1}'`)).toBe(
      'AC012',
    );
  });

  it('an edit is a new version based on the old one; rejection keeps it with its note', async () => {
    await app.query(script(S2, 2));
    await app.query(review('script_versions', S2, 'rejected', `'too long'`));
    await app.query(script(S3, 3));
  });
});

describe('approval pointers (AC013)', () => {
  it.each([
    [
      'a pending script',
      `UPDATE content_items SET approved_script_version_id = '${S3}' WHERE id = '${CI}'`,
      'AC013',
    ],
    [
      'a rejected script',
      `UPDATE content_items SET approved_script_version_id = '${S2}' WHERE id = '${CI}'`,
      'AC013',
    ],
    [
      'a script of another item',
      `UPDATE content_items SET approved_script_version_id = '${S1}' WHERE id = '${CI2}'`,
      '23503',
    ],
  ])('rejects pointing to %s', async (_n, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('points to the approved script', async () => {
    await app.query(
      `UPDATE content_items SET approved_script_version_id = '${S1}' WHERE id = '${CI}'`,
    );
  });
});

describe('storyboards and scenes', () => {
  it('stores a version with scenes and reference assets of the same project', async () => {
    await app.query(storyboard(SB1, 1, S1));
    await app.query(scene(SC1, SB1, 1, { cv: `'${CV}'` }));
    await app.query(
      `INSERT INTO storyboard_scene_assets (project_id, scene_id, asset_id) VALUES ('${P}', '${SC1}', '${A1}')`,
    );
  });

  it.each([
    [
      'a scene asset of another project',
      `INSERT INTO storyboard_scene_assets (project_id, scene_id, asset_id) VALUES ('${P}', '${SC1}', '${A9}')`,
      '23503',
    ],
    [
      'a scene in another project',
      scene('64000000-0000-7000-8000-0000000000c1', SB1, 2, { project: `'${P2}'` }),
      '23503',
    ],
    ['a duplicate scene number', scene('64000000-0000-7000-8000-0000000000c2', SB1, 1), '23505'],
    [
      'a zero duration',
      scene('64000000-0000-7000-8000-0000000000c3', SB1, 3, { duration: '0' }),
      '23514',
    ],
    [
      'changing a scene',
      `UPDATE storyboard_scenes SET image_prompt = 'x' WHERE id = '${SC1}'`,
      'AC012',
    ],
    ['deleting a scene', `DELETE FROM storyboard_scenes WHERE id = '${SC1}'`, 'AC012'],
    [
      'deleting a scene asset',
      `DELETE FROM storyboard_scene_assets WHERE scene_id = '${SC1}'`,
      'AC012',
    ],
    [
      'a storyboard of a script of another item',
      storyboard('63000000-0000-7000-8000-0000000000c4', 9, 'ffffffff-0000-7000-8000-000000000000'),
      '23503',
    ],
  ])('rejects %s', async (_n, sql, state) => {
    expect(await fails(sql)).toBe(state);
  });

  it('approves only a storyboard of the approved script, then points to it', async () => {
    await app.query(review('storyboard_versions', SB1, 'approved'));
    await app.query(
      `UPDATE content_items SET approved_storyboard_version_id = '${SB1}' WHERE id = '${CI}'`,
    );
    expect(await fails(scene('64000000-0000-7000-8000-0000000000d1', SB1, 2))).toBe('AC012');
  });

  it('a newer approved script must clear the storyboard pointer (staleness)', async () => {
    // S4: a new edited script, approved.
    const S4 = '62000000-0000-7000-8000-000000000004';
    await app.query(script(S4, 4));
    await app.query(review('script_versions', S4, 'approved'));
    expect(
      await fails(
        `UPDATE content_items SET approved_script_version_id = '${S4}' WHERE id = '${CI}'`,
      ),
    ).toBe('AC013');
    await app.query(
      `UPDATE content_items SET approved_script_version_id = '${S4}', approved_storyboard_version_id = NULL WHERE id = '${CI}'`,
    );
    // A pending storyboard of the old script is now stale and cannot be approved.
    await app.query(storyboard(SB2, 2, S1, SB1));
    expect(await fails(review('storyboard_versions', SB2, 'approved'))).toBe('AC013');
    expect(
      await fails(
        `UPDATE content_items SET approved_storyboard_version_id = '${SB1}' WHERE id = '${CI}'`,
      ),
    ).toBe('AC013');
    expect(await fails(review('storyboard_versions', SB2, 'rejected', `'stale'`))).toBeNull();
  });
});

describe('invocations link to jobs', () => {
  it('rejects a job of another project', async () => {
    expect(
      await fails(`INSERT INTO ai_invocations (id, project_id, generation_job_id, correlation_id, capability, provider_id, model_id, request_summary)
        VALUES (gen_random_uuid(), '${P2}', '${JOB}', 'c', 'llm', '${PROV}', '${MODEL}', '{}')`),
    ).toBe('23503');
    expect(
      await fails(`INSERT INTO ai_invocations (id, project_id, generation_job_id, correlation_id, capability, provider_id, model_id, request_summary)
        VALUES (gen_random_uuid(), '${P}', '${JOB}', 'c', 'llm', '${PROV}', '${MODEL}', '{}')`),
    ).toBeNull();
  });
});

describe('task routes', () => {
  it('one model per task; unknown models refused', async () => {
    await app.query(
      `INSERT INTO ai_task_routes (task, model_id, updated_at) VALUES ('script_generation', '${MODEL}', now())`,
    );
    expect(
      await fails(
        `INSERT INTO ai_task_routes (task, model_id, updated_at) VALUES ('script_generation', '${MODEL}', now())`,
      ),
    ).toBe('23505');
    expect(
      await fails(
        `INSERT INTO ai_task_routes (task, model_id, updated_at) VALUES ('storyboard_generation', gen_random_uuid(), now())`,
      ),
    ).toBe('23503');
  });
});
