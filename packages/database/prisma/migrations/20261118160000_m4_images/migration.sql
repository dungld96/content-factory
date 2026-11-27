-- M4c: image generation lineage and scene keyframes (docs/design/M4-design-review-package.md
-- §4.4, §5). Additive: new columns are nullable, existing rows stay valid.

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "generation_job_id" UUID,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by_id" UUID,
ADD COLUMN     "storyboard_scene_id" UUID;

-- AlterTable
ALTER TABLE "generation_jobs" ADD COLUMN     "storyboard_scene_id" UUID;

-- CreateTable
CREATE TABLE "asset_inputs" (
    "project_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "input_asset_id" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_inputs_pkey" PRIMARY KEY ("asset_id","input_asset_id")
);

-- CreateTable
CREATE TABLE "scene_keyframes" (
    "storyboard_scene_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "selected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scene_keyframes_pkey" PRIMARY KEY ("storyboard_scene_id")
);

-- CreateTable
CREATE TABLE "scene_keyframe_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storyboard_scene_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "selected_by_id" UUID NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scene_keyframe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_inputs_input_asset_id_idx" ON "asset_inputs"("input_asset_id");

-- CreateIndex
CREATE INDEX "scene_keyframes_asset_id_idx" ON "scene_keyframes"("asset_id");

-- CreateIndex
CREATE INDEX "scene_keyframes_selected_by_id_idx" ON "scene_keyframes"("selected_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_keyframes_project_id_storyboard_scene_id_key" ON "scene_keyframes"("project_id", "storyboard_scene_id");

-- CreateIndex
CREATE INDEX "scene_keyframe_events_storyboard_scene_id_created_at_idx" ON "scene_keyframe_events"("storyboard_scene_id", "created_at");

-- CreateIndex
CREATE INDEX "scene_keyframe_events_asset_id_idx" ON "scene_keyframe_events"("asset_id");

-- CreateIndex
CREATE INDEX "scene_keyframe_events_selected_by_id_idx" ON "scene_keyframe_events"("selected_by_id");

-- CreateIndex
CREATE INDEX "assets_generation_job_id_idx" ON "assets"("generation_job_id");

-- CreateIndex
CREATE INDEX "assets_storyboard_scene_id_idx" ON "assets"("storyboard_scene_id");

-- CreateIndex
CREATE INDEX "assets_reviewed_by_id_idx" ON "assets"("reviewed_by_id");

-- CreateIndex
CREATE INDEX "generation_jobs_storyboard_scene_id_idx" ON "generation_jobs"("storyboard_scene_id");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_generation_job_id_fkey" FOREIGN KEY ("project_id", "generation_job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_project_id_input_asset_id_fkey" FOREIGN KEY ("project_id", "input_asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframes" ADD CONSTRAINT "scene_keyframes_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframes" ADD CONSTRAINT "scene_keyframes_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframes" ADD CONSTRAINT "scene_keyframes_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframe_events" ADD CONSTRAINT "scene_keyframe_events_project_id_storyboard_scene_id_fkey" FOREIGN KEY ("project_id", "storyboard_scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframe_events" ADD CONSTRAINT "scene_keyframe_events_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "scene_keyframe_events" ADD CONSTRAINT "scene_keyframe_events_selected_by_id_fkey" FOREIGN KEY ("selected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- generation jobs

-- An image job belongs to exactly one storyboard scene; text jobs to none.
ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_scene_consistent"
    CHECK (("kind" = 'image_generation') = ("storyboard_scene_id" IS NOT NULL));

-- One active job per content item and kind (text), or per scene (images).
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_active_key_consistent";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_active_key_consistent" CHECK (
  ("status" IN ('queued', 'running')) = ("active_key" IS NOT NULL)
  AND ("active_key" IS NULL OR "active_key" = CASE
        WHEN "kind" = 'image_generation' THEN "storyboard_scene_id"::text || ':image_generation'
        ELSE "content_item_id"::text || ':' || "kind"::text END));

-- A succeeded text job links exactly its result version; image jobs link their results
-- through assets.generation_job_id, so they link no version.
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_result_consistent";
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_result_consistent" CHECK (
  CASE WHEN "status" = 'succeeded' AND "kind" <> 'image_generation' THEN
    ("kind" = 'script_generation' AND "result_script_version_id" IS NOT NULL AND "result_storyboard_version_id" IS NULL)
    OR ("kind" = 'storyboard_generation' AND "result_storyboard_version_id" IS NOT NULL AND "result_script_version_id" IS NULL)
  ELSE "result_script_version_id" IS NULL AND "result_storyboard_version_id" IS NULL END);

-- The scene is part of a job's identity (same function as M3, one more column).
CREATE OR REPLACE FUNCTION acf_generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_cols text[] := ARRAY['id', 'project_id', 'content_item_id', 'production_run_id', 'kind',
    'idempotency_key', 'execution_key', 'input', 'previous_content_status', 'prompt_template_id',
    'model_id', 'max_attempts', 'requested_by_id', 'queued_at', 'storyboard_scene_id'];
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
  IF (SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) FROM unnest(identity_cols) k)
     IS DISTINCT FROM (SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) FROM unnest(identity_cols) k) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'generation_jobs identity columns are immutable';
  END IF;
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'attempt never decreases';
  END IF;
  IF OLD.prompt_snapshot IS NOT NULL AND NEW.prompt_snapshot IS DISTINCT FROM OLD.prompt_snapshot THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'the recorded prompt snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- assets

ALTER TABLE "assets"
  -- Generated assets come from a job; nothing else claims one.
  ADD CONSTRAINT "assets_generated_has_job"
    CHECK (("source_type" = 'generated') = ("generation_job_id" IS NOT NULL)),
  ADD CONSTRAINT "assets_scene_only_generated"
    CHECK ("storyboard_scene_id" IS NULL OR "source_type" = 'generated'),
  ADD CONSTRAINT "assets_review_consistent"
    CHECK (("reviewed_by_id" IS NULL) = ("reviewed_at" IS NULL));

-- M1 guard + M4: job/scene links are identity; an asset used as a keyframe cannot be archived
-- (AC008) or lose its approval (AC015). Lock order: asset (this UPDATE) only; the keyframe
-- trigger takes the asset row FOR SHARE, so the two serialize on the asset row.
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
  END IF;

  IF OLD.approval_status = 'approved' AND NEW.approval_status <> 'approved'
     AND EXISTS (SELECT 1 FROM scene_keyframes WHERE asset_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC015', MESSAGE = 'a scene keyframe must stay approved';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- lineage (append-only)

ALTER TABLE "asset_inputs"
  ADD CONSTRAINT "asset_inputs_role_known" CHECK ("role" IN ('character', 'environment', 'scene_reference')),
  ADD CONSTRAINT "asset_inputs_not_self" CHECK ("asset_id" <> "input_asset_id");

CREATE FUNCTION acf_asset_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'AC005', MESSAGE = 'asset lineage (asset_inputs) is append-only';
END $$;

CREATE TRIGGER asset_inputs_append_only BEFORE UPDATE OR DELETE ON "asset_inputs"
  FOR EACH ROW EXECUTE FUNCTION acf_asset_input_guard();

-- ---------------------------------------------------------------- keyframes (AC015)

ALTER TABLE "scene_keyframe_events"
  ADD CONSTRAINT "scene_keyframe_events_reason_known" CHECK ("reason" IN ('selected', 'reused'));

-- A keyframe is an approved, active image of the scene's own content item. Never deleted; the
-- scene never changes. The asset row is read FOR SHARE, which conflicts with the asset UPDATE
-- that would archive it or revoke its approval (see acf_asset_guard).
CREATE FUNCTION acf_scene_keyframe_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a record;
  scene_item uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC015', MESSAGE = 'scene keyframes cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.storyboard_scene_id, NEW.project_id)
     IS DISTINCT FROM (OLD.storyboard_scene_id, OLD.project_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC015', MESSAGE = 'a keyframe belongs to its scene';
  END IF;
  SELECT asset_type::text AS asset_type, approval_status::text AS approval_status, archived_at, content_item_id
    INTO a FROM assets WHERE id = NEW.asset_id FOR SHARE;
  SELECT v.content_item_id INTO scene_item
    FROM storyboard_scenes s JOIN storyboard_versions v ON v.id = s.storyboard_version_id
    WHERE s.id = NEW.storyboard_scene_id;
  IF a.asset_type IS DISTINCT FROM 'image' OR a.approval_status IS DISTINCT FROM 'approved'
     OR a.archived_at IS NOT NULL OR a.content_item_id IS DISTINCT FROM scene_item THEN
    RAISE EXCEPTION USING ERRCODE = 'AC015',
      MESSAGE = 'a keyframe must be an approved, active image of the scene''s content item';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER scene_keyframes_guard BEFORE INSERT OR UPDATE OR DELETE ON "scene_keyframes"
  FOR EACH ROW EXECUTE FUNCTION acf_scene_keyframe_guard();

CREATE TRIGGER scene_keyframe_events_append_only BEFORE UPDATE OR DELETE ON "scene_keyframe_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
