-- M5c: async video jobs, scene clips and voice-overs, voice profiles
-- (docs/design/M5-design-review-package.md §5–§7; decisions V3, V6, V7). Additive: new columns
-- are nullable (or defaulted), existing rows stay valid.

-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "voice_profile_id" UUID;

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "invocation_id" UUID,
ADD COLUMN     "last_polled_at" TIMESTAMPTZ(3),
ADD COLUMN     "next_poll_at" TIMESTAMPTZ(3),
ADD COLUMN     "poll_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "provider_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "provider_job_id" VARCHAR(200),
ADD COLUMN     "provider_key" VARCHAR(64),
ADD COLUMN     "provider_status" VARCHAR(32),
ADD COLUMN     "submitted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "scene_clips" (
    "storyboard_scene_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scene_clips_pkey" PRIMARY KEY ("storyboard_scene_id")
);

-- CreateTable
CREATE TABLE "scene_clip_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storyboard_scene_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_clip_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_voiceovers" (
    "storyboard_scene_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scene_voiceovers_pkey" PRIMARY KEY ("storyboard_scene_id")
);

-- CreateTable
CREATE TABLE "scene_voiceover_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storyboard_scene_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_voiceover_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_profiles" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "model_id" UUID NOT NULL,
    "voice" VARCHAR(200) NOT NULL,
    "language" VARCHAR(35) NOT NULL,
    "speed" DECIMAL(3,2),
    "instructions" VARCHAR(500),
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scene_clips_asset_id_idx" ON "scene_clips"("asset_id");

-- CreateIndex
CREATE INDEX "scene_clips_selected_by_id_idx" ON "scene_clips"("selected_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_clips_project_id_storyboard_scene_id_key" ON "scene_clips"("project_id", "storyboard_scene_id");

-- CreateIndex
CREATE INDEX "scene_clip_events_storyboard_scene_id_created_at_idx" ON "scene_clip_events"("storyboard_scene_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_clip_events_asset_id_idx" ON "scene_clip_events"("asset_id");

-- CreateIndex
CREATE INDEX "scene_clip_events_selected_by_id_idx" ON "scene_clip_events"("selected_by_id");

-- CreateIndex
CREATE INDEX "scene_voiceovers_asset_id_idx" ON "scene_voiceovers"("asset_id");

-- CreateIndex
CREATE INDEX "scene_voiceovers_selected_by_id_idx" ON "scene_voiceovers"("selected_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_voiceovers_project_id_storyboard_scene_id_key" ON "scene_voiceovers"("project_id", "storyboard_scene_id");

-- CreateIndex
CREATE INDEX "scene_voiceover_events_storyboard_scene_id_created_at_idx" ON "scene_voiceover_events"("storyboard_scene_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_voiceover_events_asset_id_idx" ON "scene_voiceover_events"("asset_id");

-- CreateIndex
CREATE INDEX "scene_voiceover_events_selected_by_id_idx" ON "scene_voiceover_events"("selected_by_id");

-- CreateIndex
CREATE INDEX "voice_profiles_project_id_archived_at_idx" ON "voice_profiles"("project_id", "archived_at");

-- CreateIndex
CREATE INDEX "voice_profiles_model_id_idx" ON "voice_profiles"("model_id");

-- CreateIndex
CREATE INDEX "voice_profiles_created_by_id_idx" ON "voice_profiles"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_profiles_project_id_id_key" ON "voice_profiles"("project_id", "id");

-- CreateIndex
CREATE INDEX "content_items_voice_profile_id_idx" ON "content_items"("voice_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_provider_job_id_key" ON "generation_jobs"("provider_job_id");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_voice_profile_id_fkey" FOREIGN KEY ("project_id", "voice_profile_id") REFERENCES "voice_profiles"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_invocation_id_fkey" FOREIGN KEY ("project_id", "invocation_id") REFERENCES "ai_invocations"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clips" ADD CONSTRAINT "scene_clips_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clips" ADD CONSTRAINT "scene_clips_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clips" ADD CONSTRAINT "scene_clips_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clip_events" ADD CONSTRAINT "scene_clip_events_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clip_events" ADD CONSTRAINT "scene_clip_events_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_clip_events" ADD CONSTRAINT "scene_clip_events_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceovers" ADD CONSTRAINT "scene_voiceovers_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceovers" ADD CONSTRAINT "scene_voiceovers_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceovers" ADD CONSTRAINT "scene_voiceovers_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceover_events" ADD CONSTRAINT "scene_voiceover_events_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceover_events" ADD CONSTRAINT "scene_voiceover_events_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_voiceover_events" ADD CONSTRAINT "scene_voiceover_events_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- generation jobs (async)

-- Image, video and TTS jobs belong to exactly one storyboard scene; text jobs to none.
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_scene_consistent";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_scene_consistent"
  CHECK (("kind" IN ('image_generation', 'video_generation', 'tts_generation'))
         = ("storyboard_scene_id" IS NOT NULL));

-- One active job per content item and kind (text), or per scene and kind (media).
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_active_key_consistent";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_active_key_consistent" CHECK (
  ("status" IN ('queued', 'running')) = ("active_key" IS NOT NULL)
  AND ("active_key" IS NULL OR "active_key" = CASE
        WHEN "kind" IN ('image_generation', 'video_generation', 'tts_generation')
          THEN "storyboard_scene_id"::text || ':' || "kind"::text
        ELSE "content_item_id"::text || ':' || "kind"::text END));

-- Only text jobs link a result version; media jobs link results through assets.
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_result_consistent";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_result_consistent" CHECK (
  CASE WHEN "status" = 'succeeded' AND "kind" IN ('script_generation', 'storyboard_generation') THEN
    ("kind" = 'script_generation' AND "result_script_version_id" IS NOT NULL AND "result_storyboard_version_id" IS NULL)
    OR ("kind" = 'storyboard_generation' AND "result_storyboard_version_id" IS NOT NULL AND "result_script_version_id" IS NULL)
  ELSE "result_script_version_id" IS NULL AND "result_storyboard_version_id" IS NULL END);

-- Provider tracking exists only for video jobs; a provider job id implies the submission intent
-- (submitted_at, invocation, adapter) that preceded it.
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_provider_only_video" CHECK (
    "kind" = 'video_generation'
    OR ("provider_key" IS NULL AND "provider_job_id" IS NULL AND "provider_status" IS NULL
        AND "invocation_id" IS NULL AND "submitted_at" IS NULL AND "poll_count" = 0)),
  ADD CONSTRAINT "generation_jobs_provider_job_has_intent" CHECK (
    "provider_job_id" IS NULL
    OR ("submitted_at" IS NOT NULL AND "invocation_id" IS NOT NULL AND "provider_key" IS NOT NULL)),
  ADD CONSTRAINT "generation_jobs_poll_count_nonnegative" CHECK ("poll_count" >= 0);

-- M4 guard + M5: once the provider job id is recorded, it and its submission intent (adapter,
-- invocation, submitted_at) never change or disappear (decision V3: resume by polling, never
-- resubmit). Before that, the intent may be cleared when the provider refused the submit.
CREATE OR REPLACE FUNCTION acf_generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_cols text[] := ARRAY['id', 'project_id', 'content_item_id', 'production_run_id', 'kind',
    'idempotency_key', 'execution_key', 'input', 'previous_content_status', 'prompt_template_id',
    'model_id', 'max_attempts', 'requested_by_id', 'queued_at', 'storyboard_scene_id'];
  frozen_with_job text[] := ARRAY['provider_key', 'provider_job_id', 'invocation_id', 'submitted_at'];
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'generation_jobs rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.attempt <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'generation_jobs rows are inserted as queued, attempt 0';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'canceled') THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011',
      MESSAGE = format('generation job %s is %s and cannot change', OLD.id, OLD.status);
  END IF;
  IF (SELECT jsonb_object_agg(k2, to_jsonb(NEW) -> k2) FROM unnest(identity_cols) k2)
     IS DISTINCT FROM (SELECT jsonb_object_agg(k2, to_jsonb(OLD) -> k2) FROM unnest(identity_cols) k2) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'generation_jobs identity columns are immutable';
  END IF;
  IF OLD.provider_job_id IS NOT NULL THEN
    FOREACH k IN ARRAY frozen_with_job LOOP
      IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
        RAISE EXCEPTION USING ERRCODE = 'AC011',
          MESSAGE = format('generation_jobs.%s is frozen once the provider job id is recorded', k);
      END IF;
    END LOOP;
  END IF;
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'attempt never decreases';
  END IF;
  IF NEW.poll_count < OLD.poll_count THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'poll_count never decreases';
  END IF;
  IF OLD.prompt_snapshot IS NOT NULL AND NEW.prompt_snapshot IS DISTINCT FROM OLD.prompt_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'the recorded prompt snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- lineage

-- A clip's input is the keyframe it was generated from.
ALTER TABLE "asset_inputs" DROP CONSTRAINT "asset_inputs_role_known";
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_role_known"
  CHECK ("role" IN ('character', 'environment', 'scene_reference', 'keyframe'));

-- ---------------------------------------------------------------- assets in use (AC008, AC016)

-- M4 guard + M5: a selected clip or voice-over cannot be archived (AC008) or lose its approval
-- (AC016), like a keyframe (AC015).
CREATE OR REPLACE FUNCTION acf_asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_keys text[] := ARRAY['id','project_id','content_item_id','asset_type','source_type',
    'source_asset_id','source_note','storage_key','mime_type','size_bytes','checksum_sha256',
    'width','height','duration_ms','original_filename','created_by_id','created_at',
    'generation_job_id','storyboard_scene_id'];
  k text;
BEGIN
  FOREACH k IN ARRAY frozen_keys LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC005', MESSAGE = format('asset column %s is immutable', k);
    END IF;
  END LOOP;

  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM character_versions   WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_versions WHERE primary_asset_id = NEW.id AND status = 'approved')
    OR EXISTS (SELECT 1 FROM character_version_assets l JOIN character_versions v ON v.id = l.character_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved')
    OR EXISTS (SELECT 1 FROM environment_version_assets l JOIN environment_versions v ON v.id = l.environment_version_id
               WHERE l.asset_id = NEW.id AND v.status = 'approved') THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is referenced by an approved version and cannot be archived';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_keyframes WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is a scene keyframe and cannot be archived';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_clips WHERE asset_id = NEW.id)
    OR EXISTS (SELECT 1 FROM scene_voiceovers WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC008', MESSAGE = 'asset is a selected scene clip or voice-over and cannot be archived';
    END IF;
  END IF;

  IF OLD.approval_status = 'approved' AND NEW.approval_status <> 'approved' THEN
    IF EXISTS (SELECT 1 FROM scene_keyframes WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC015', MESSAGE = 'a scene keyframe must stay approved';
    END IF;
    IF EXISTS (SELECT 1 FROM scene_clips WHERE asset_id = NEW.id)
    OR EXISTS (SELECT 1 FROM scene_voiceovers WHERE asset_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC016', MESSAGE = 'a selected scene clip or voice-over must stay approved';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- clips and voice-overs (AC016)

ALTER TABLE "scene_clip_events"
  ADD CONSTRAINT "scene_clip_events_reason_known" CHECK ("reason" IN ('selected', 'reused', 'cleared'));
ALTER TABLE "scene_voiceover_events"
  ADD CONSTRAINT "scene_voiceover_events_reason_known" CHECK ("reason" IN ('selected', 'reused', 'cleared'));

-- A clip is an approved, active video of the scene's content item. A voice-over is an approved,
-- active audio file of the scene's content item, or an upload not tied to any content item of
-- the same project (imported narration). The scene never changes; a selection may be cleared
-- (deleted, e.g. when the keyframe changes). Asset rows are read FOR SHARE, which conflicts with
-- the asset UPDATE that would archive them or revoke their approval (see acf_asset_guard).
CREATE FUNCTION acf_scene_media_selection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a record;
  scene_item uuid;
  wanted text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.storyboard_scene_id, NEW.project_id)
     IS DISTINCT FROM (OLD.storyboard_scene_id, OLD.project_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC016', MESSAGE = 'a selection belongs to its scene';
  END IF;
  SELECT asset_type::text AS asset_type, approval_status::text AS approval_status, archived_at,
         content_item_id, source_type::text AS source_type
    INTO a FROM assets WHERE id = NEW.asset_id FOR SHARE;
  SELECT v.content_item_id INTO scene_item
    FROM storyboard_scenes s JOIN storyboard_versions v ON v.id = s.storyboard_version_id
    WHERE s.id = NEW.storyboard_scene_id;
  IF a.asset_type IS DISTINCT FROM wanted OR a.approval_status IS DISTINCT FROM 'approved'
     OR a.archived_at IS NOT NULL
     OR NOT (a.content_item_id IS NOT DISTINCT FROM scene_item
             OR (wanted = 'audio' AND a.source_type = 'upload' AND a.content_item_id IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC016',
      MESSAGE = format('a scene selection must be an approved, active %s of the scene''s content item', wanted);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER scene_clips_guard BEFORE INSERT OR UPDATE OR DELETE ON "scene_clips"
  FOR EACH ROW EXECUTE FUNCTION acf_scene_media_selection_guard('video');
CREATE TRIGGER scene_voiceovers_guard BEFORE INSERT OR UPDATE OR DELETE ON "scene_voiceovers"
  FOR EACH ROW EXECUTE FUNCTION acf_scene_media_selection_guard('audio');

CREATE TRIGGER scene_clip_events_append_only BEFORE UPDATE OR DELETE ON "scene_clip_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
CREATE TRIGGER scene_voiceover_events_append_only BEFORE UPDATE OR DELETE ON "scene_voiceover_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();

-- ---------------------------------------------------------------- voice profiles

ALTER TABLE "voice_profiles"
  ADD CONSTRAINT "voice_profiles_name_nonempty" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "voice_profiles_voice_nonempty" CHECK (length(btrim("voice")) > 0),
  ADD CONSTRAINT "voice_profiles_language_format" CHECK ("language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  ADD CONSTRAINT "voice_profiles_speed_range" CHECK ("speed" IS NULL OR ("speed" >= 0.5 AND "speed" <= 2)),
  ADD CONSTRAINT "voice_profiles_instructions_nonempty" CHECK ("instructions" IS NULL OR length(btrim("instructions")) > 0);

CREATE TRIGGER voice_profiles_no_delete BEFORE DELETE ON "voice_profiles"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
