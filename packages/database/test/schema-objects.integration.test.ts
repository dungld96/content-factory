// Guards against silent loss of the integrity layer (design package §6.4 items 7–8) and
// verifies the database role separation (ADR-0011 §8, decision U3).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { connect, sqlStateOf } from './support/db.js';

const run = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, '..');

let migrator: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

/** [table, trigger, deferrable] — every trigger the migration must create, enabled. */
const EXPECTED_TRIGGERS: readonly (readonly [string, string, boolean])[] = [
  ['ai_invocations', 'ai_invocations_guard', false],
  ['ai_model_prices', 'ai_model_prices_append_only', false],
  ['ai_registry_events', 'ai_registry_events_append_only', false],
  ['ai_usage_records', 'ai_usage_records_append_only', false],
  ['asset_collections', 'asset_collections_no_delete', false],
  ['asset_inputs', 'asset_inputs_append_only', false],
  ['assets', 'assets_guard', false],
  ['assets', 'assets_no_delete', false],
  ['budget_events', 'budget_events_append_only', false],
  ['budget_reservations', 'budget_reservations_guard', false],
  ['channels', 'channels_no_delete', false],
  ['character_version_assets', 'character_version_assets_guard', false],
  ['character_versions', 'character_versions_approval_sets_master', true],
  ['character_versions', 'character_versions_guard', false],
  ['characters', 'characters_master_guard', false],
  ['characters', 'characters_no_delete', false],
  ['content_items', 'content_items_master_link_guard', false],
  ['content_items', 'content_items_no_delete', false],
  ['content_items', 'content_items_pointer_guard', false],
  ['content_items', 'content_items_render_pointer_guard', false],
  ['content_masters', 'content_masters_no_delete', false],
  ['environment_version_assets', 'environment_version_assets_guard', false],
  ['environment_versions', 'environment_versions_approval_sets_master', true],
  ['environment_versions', 'environment_versions_guard', false],
  ['environments', 'environments_master_guard', false],
  ['environments', 'environments_no_delete', false],
  ['generation_jobs', 'generation_jobs_guard', false],
  ['job_events', 'job_events_append_only', false],
  ['production_runs', 'production_runs_guard', false],
  ['project_budgets', 'project_budgets_no_delete', false],
  ['project_members', 'project_members_keep_owner', true],
  ['projects', 'projects_created_with_owner', true],
  ['projects', 'projects_no_delete', false],
  ['provider_circuit_events', 'provider_circuit_events_append_only', false],
  ['provider_circuits', 'provider_circuits_no_delete', false],
  ['renders', 'renders_guard', false],
  ['scene_clip_events', 'scene_clip_events_append_only', false],
  ['scene_clips', 'scene_clips_guard', false],
  ['scene_keyframe_events', 'scene_keyframe_events_append_only', false],
  ['scene_keyframes', 'scene_keyframes_guard', false],
  ['scene_voiceover_events', 'scene_voiceover_events_append_only', false],
  ['scene_voiceovers', 'scene_voiceovers_guard', false],
  ['script_versions', 'script_versions_guard', false],
  ['storyboard_scene_assets', 'storyboard_scene_assets_guard', false],
  ['storyboard_scenes', 'storyboard_scenes_guard', false],
  ['storyboard_versions', 'storyboard_versions_guard', false],
  ['voice_profiles', 'voice_profiles_no_delete', false],
];

const EXPECTED_CHECKS = [
  'ai_invocations.ai_invocations_completion_consistent',
  'ai_invocations.ai_invocations_cost_status_consistent',
  'ai_invocations.ai_invocations_costs_nonnegative',
  'ai_invocations.ai_invocations_currency_usd',
  'ai_invocations.ai_invocations_error_consistent',
  'ai_invocations.ai_invocations_latency_nonnegative',
  'ai_invocations.ai_invocations_request_summary_object',
  'ai_model_prices.ai_model_prices_currency_usd',
  'ai_model_prices.ai_model_prices_source_url_nonempty',
  'ai_model_prices.ai_model_prices_source_value_nonempty',
  'ai_model_prices.ai_model_prices_tier_nonnegative',
  'ai_model_prices.ai_model_prices_unit_price_nonnegative',
  'ai_model_prices.ai_model_prices_variant_format',
  'ai_models.ai_models_benchmark_range',
  'ai_models.ai_models_context_positive',
  'ai_models.ai_models_image_constraints_object',
  'ai_models.ai_models_max_output_positive',
  'ai_models.ai_models_media_constraints_kind',
  'ai_models.ai_models_model_key_nonempty',
  'ai_models.ai_models_schema_mode_known',
  'ai_providers.ai_providers_key_format',
  'ai_providers.ai_providers_kind_known',
  'ai_providers.ai_providers_name_nonempty',
  'ai_registry_events.ai_registry_events_action_known',
  'ai_registry_events.ai_registry_events_actor_matches_source',
  'ai_registry_events.ai_registry_events_source_known',
  'ai_usage_records.ai_usage_records_cost_consistent',
  'ai_usage_records.ai_usage_records_price_needs_unit_price',
  'ai_usage_records.ai_usage_records_quantity_nonnegative',
  'ai_usage_records.ai_usage_records_unit_price_nonnegative',
  'asset_collections.asset_collections_name_nonempty',
  'asset_inputs.asset_inputs_not_self',
  'asset_inputs.asset_inputs_role_known',
  'assets.assets_checksum_format',
  'assets.assets_derived_has_source',
  'assets.assets_dimensions_positive',
  'assets.assets_duration_nonnegative',
  'assets.assets_generated_has_job',
  'assets.assets_not_own_source',
  'assets.assets_review_consistent',
  'assets.assets_scene_only_generated',
  'assets.assets_size_nonnegative',
  'assets.assets_storage_key_nonempty',
  'budget_events.budget_events_detail_object',
  'budget_events.budget_events_type_known',
  'budget_reservations.budget_reservations_amount_nonnegative',
  'budget_reservations.budget_reservations_resolved_consistent',
  'budget_reservations.budget_reservations_settled_charge_consistent',
  'character_versions.character_versions_approval_consistent',
  'character_versions.character_versions_not_based_on_self',
  'character_versions.character_versions_version_positive',
  'content_items.content_items_duration_range',
  'content_items.content_items_master_brief_revision_positive',
  'content_items.content_items_platform_xor_channel',
  'content_masters.content_masters_brief_revision_positive',
  'environment_versions.environment_versions_approval_consistent',
  'environment_versions.environment_versions_not_based_on_self',
  'environment_versions.environment_versions_version_positive',
  'generation_jobs.generation_jobs_active_key_consistent',
  'generation_jobs.generation_jobs_attempts_bounded',
  'generation_jobs.generation_jobs_completion_consistent',
  'generation_jobs.generation_jobs_delivery_media_only',
  'generation_jobs.generation_jobs_error_consistent',
  'generation_jobs.generation_jobs_execution_key_format',
  'generation_jobs.generation_jobs_input_object',
  'generation_jobs.generation_jobs_poll_count_nonnegative',
  'generation_jobs.generation_jobs_provider_job_has_intent',
  'generation_jobs.generation_jobs_provider_only_video',
  'generation_jobs.generation_jobs_recover_media_only',
  'generation_jobs.generation_jobs_recover_not_self',
  'generation_jobs.generation_jobs_result_consistent',
  'generation_jobs.generation_jobs_scene_consistent',
  'generation_jobs.generation_jobs_staged_complete',
  'job_events.job_events_attempt_nonnegative',
  'job_events.job_events_detail_object',
  'production_runs.production_runs_completion_consistent',
  'production_runs.production_runs_not_resumed_from_self',
  'project_budgets.project_budgets_item_nonnegative',
  'project_budgets.project_budgets_monthly_nonnegative',
  'project_budgets.project_budgets_request_nonnegative',
  'project_budgets.project_budgets_threshold_range',
  'provider_circuit_events.provider_circuit_events_reason_known',
  'provider_circuits.provider_circuits_failures_nonnegative',
  'provider_circuits.provider_circuits_open_consistent',
  'provider_circuits.provider_circuits_open_for_positive',
  'provider_circuits.provider_circuits_trial_consistent',
  'renders.renders_duration_positive',
  'renders.renders_execution_key_format',
  'renders.renders_export_consistent',
  'renders.renders_manifest_object',
  'renders.renders_outputs_together',
  'renders.renders_qc_object',
  'renders.renders_review_consistent',
  'renders.renders_review_note_nonempty',
  'renders.renders_settings_object',
  'scene_clip_events.scene_clip_events_reason_known',
  'scene_keyframe_events.scene_keyframe_events_reason_known',
  'scene_voiceover_events.scene_voiceover_events_reason_known',
  'script_versions.script_versions_content_object',
  'script_versions.script_versions_not_based_on_self',
  'script_versions.script_versions_review_consistent',
  'script_versions.script_versions_source_consistent',
  'script_versions.script_versions_version_positive',
  'sessions.sessions_expiry_order',
  'sessions.sessions_id_hash_len',
  'storyboard_scenes.storyboard_scenes_duration_positive',
  'storyboard_scenes.storyboard_scenes_number_positive',
  'storyboard_versions.storyboard_versions_duration_positive',
  'storyboard_versions.storyboard_versions_not_based_on_self',
  'storyboard_versions.storyboard_versions_review_consistent',
  'storyboard_versions.storyboard_versions_source_consistent',
  'storyboard_versions.storyboard_versions_version_positive',
  'users.users_email_normalized',
  'users.users_locale_known',
  'voice_profiles.voice_profiles_instructions_nonempty',
  'voice_profiles.voice_profiles_language_format',
  'voice_profiles.voice_profiles_name_nonempty',
  'voice_profiles.voice_profiles_speed_range',
  'voice_profiles.voice_profiles_voice_nonempty',
  'workspace_settings.workspace_settings_singleton',
  'workspace_settings.workspace_settings_threshold_range',
];

describe('integrity layer presence', () => {
  it('has every trigger, enabled, with the expected deferrability', async () => {
    const { rows } = await migrator.query<{
      tbl: string;
      tgname: string;
      tgenabled: string;
      deferrable: boolean;
    }>(`SELECT c.relname AS tbl, t.tgname, t.tgenabled, t.tgdeferrable AS deferrable
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`);
    expect(rows.map((r) => [r.tbl, r.tgname, r.deferrable])).toEqual(EXPECTED_TRIGGERS);
    // 'O' = fires in origin/local mode (enabled). 'D' would mean disabled.
    expect(rows.filter((r) => r.tgenabled !== 'O')).toEqual([]);
  });

  it('has every CHECK constraint, validated', async () => {
    const { rows } = await migrator.query<{ name: string; convalidated: boolean }>(
      `SELECT c.relname || '.' || k.conname AS name, k.convalidated
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND k.contype = 'c' ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_CHECKS);
    expect(rows.every((r) => r.convalidated)).toBe(true);
  });

  it('has no Prisma drift: the migrated database matches schema.prisma', async () => {
    // Triggers, functions and CHECKs are invisible to Prisma, so the diff must be empty.
    const { stdout } = await run(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        path.join('prisma', 'schema.prisma'),
        '--exit-code',
      ],
      {
        cwd: packageDir,
        env: { ...process.env, DATABASE_MIGRATION_URL: inject('databaseUrls').migratorUrl },
      },
    );
    expect(stdout).toContain('No difference detected');
  });
});

describe('role separation (U3)', () => {
  it('runs the app as a non-superuser, non-owner role', async () => {
    const { rows } = await app.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
      owns_tables: boolean;
    }>(`SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
          EXISTS (SELECT 1 FROM pg_tables WHERE tableowner = current_user) AS owns_tables
        FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      owns_tables: false,
    });
  });

  it('owns the schema objects through the migrator, which is not a superuser', async () => {
    const { rows } = await migrator.query<{ rolsuper: boolean; foreign_owned: number }>(
      `SELECT r.rolsuper, (SELECT count(*)::int FROM pg_tables
         WHERE schemaname = 'public' AND tableowner <> current_user) AS foreign_owned
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, foreign_owned: 0 });
  });

  it.each([
    ['disable a trigger', 'ALTER TABLE assets DISABLE TRIGGER assets_guard'],
    ['drop a trigger', 'DROP TRIGGER assets_guard ON assets'],
    ['truncate a table', 'TRUNCATE assets CASCADE'],
    ['bypass triggers with session_replication_role', 'SET session_replication_role = replica'],
    [
      'replace a trigger function',
      'CREATE OR REPLACE FUNCTION acf_forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$',
    ],
    ['create a table', 'CREATE TABLE app_owned (id int)'],
    ['write the migration history', `DELETE FROM _prisma_migrations`],
    ['read the migration history', `SELECT 1 FROM _prisma_migrations`],
  ])('denies the app role: %s', async (_name, sql) => {
    let state: string | undefined;
    try {
      await app.query(sql);
    } catch (error) {
      state = sqlStateOf(error);
    }
    // 42501 insufficient_privilege; 42501/42883-family codes all mean "not allowed".
    expect(state).toBe('42501');
  });

  it('grants the app role DML on every domain table', async () => {
    const { rows } = await app.query<{ tablename: string; ok: boolean }>(
      `SELECT tablename, has_table_privilege(current_user, 'public.' || tablename, 'SELECT, INSERT, UPDATE, DELETE') AS ok
       FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    expect(rows.length).toBe(46); // M1–M3: 27; R0: content_masters; M4: 3 image tables; M5: 5 media tables; M6: renders; M7: 3 budget + 2 circuit tables; P1: ai_registry_events; P2b: 2 collection tables; redesign R-D4: workspace_settings
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
});
