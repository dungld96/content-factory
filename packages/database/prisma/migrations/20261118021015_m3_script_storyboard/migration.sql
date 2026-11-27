-- CreateEnum
CREATE TYPE "generation_job_kind" AS ENUM ('script_generation', 'storyboard_generation');

-- CreateEnum
CREATE TYPE "generation_job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "artifact_status" AS ENUM ('pending_review', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "artifact_source" AS ENUM ('generated', 'edited');

-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "approved_script_version_id" UUID,
ADD COLUMN     "approved_storyboard_version_id" UUID;

-- CreateTable
CREATE TABLE "production_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "status" "generation_job_status" NOT NULL DEFAULT 'queued',
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "production_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "production_run_id" UUID NOT NULL,
    "kind" "generation_job_kind" NOT NULL,
    "status" "generation_job_status" NOT NULL DEFAULT 'queued',
    "active_key" VARCHAR(80),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "execution_key" CHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "previous_content_status" "content_status" NOT NULL,
    "prompt_template_id" VARCHAR(64) NOT NULL,
    "prompt_snapshot" TEXT,
    "model_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "result_script_version_id" UUID,
    "result_storyboard_version_id" UUID,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "requested_by_id" UUID NOT NULL,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "from_status" "generation_job_status",
    "to_status" "generation_job_status" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "script_versions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "artifact_status" NOT NULL DEFAULT 'pending_review',
    "source" "artifact_source" NOT NULL,
    "based_on_version_id" UUID,
    "generation_job_id" UUID,
    "schema_version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "script_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboard_versions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "script_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "artifact_status" NOT NULL DEFAULT 'pending_review',
    "source" "artifact_source" NOT NULL,
    "based_on_version_id" UUID,
    "generation_job_id" UUID,
    "schema_version" INTEGER NOT NULL,
    "total_duration_seconds" DECIMAL(7,2) NOT NULL,
    "created_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storyboard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboard_scenes" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storyboard_version_id" UUID NOT NULL,
    "scene_number" INTEGER NOT NULL,
    "duration_seconds" DECIMAL(6,2) NOT NULL,
    "shot_type" VARCHAR(100) NOT NULL,
    "camera_angle" VARCHAR(100) NOT NULL,
    "camera_movement" VARCHAR(100) NOT NULL,
    "character_action" TEXT NOT NULL,
    "character_version_id" UUID,
    "environment_version_id" UUID,
    "visual_description" TEXT NOT NULL,
    "image_prompt" TEXT NOT NULL,
    "video_prompt" TEXT NOT NULL,
    "negative_prompt" TEXT NOT NULL,
    "voice_over_segment" TEXT NOT NULL,
    "on_screen_text" TEXT NOT NULL,
    "acceptance_checks" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "storyboard_scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboard_scene_assets" (
    "project_id" UUID NOT NULL,
    "scene_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,

    CONSTRAINT "storyboard_scene_assets_pkey" PRIMARY KEY ("scene_id","asset_id")
);

-- CreateTable
CREATE TABLE "ai_task_routes" (
    "task" "generation_job_kind" NOT NULL,
    "model_id" UUID NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_task_routes_pkey" PRIMARY KEY ("task")
);

-- CreateIndex
CREATE INDEX "production_runs_content_item_id_created_at_idx" ON "production_runs"("content_item_id", "created_at");

-- CreateIndex
CREATE INDEX "production_runs_requested_by_id_idx" ON "production_runs"("requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_runs_project_id_id_key" ON "production_runs"("project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_active_key_key" ON "generation_jobs"("active_key");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_idempotency_key_key" ON "generation_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "generation_jobs_content_item_id_kind_execution_key_idx" ON "generation_jobs"("content_item_id", "kind", "execution_key");

-- CreateIndex
CREATE INDEX "generation_jobs_production_run_id_idx" ON "generation_jobs"("production_run_id");

-- CreateIndex
CREATE INDEX "generation_jobs_status_queued_at_idx" ON "generation_jobs"("status", "queued_at");

-- CreateIndex
CREATE INDEX "generation_jobs_model_id_idx" ON "generation_jobs"("model_id");

-- CreateIndex
CREATE INDEX "generation_jobs_requested_by_id_idx" ON "generation_jobs"("requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_project_id_id_key" ON "generation_jobs"("project_id", "id");

-- CreateIndex
CREATE INDEX "job_events_job_id_created_at_idx" ON "job_events"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "script_versions_generation_job_id_idx" ON "script_versions"("generation_job_id");

-- CreateIndex
CREATE INDEX "script_versions_created_by_id_idx" ON "script_versions"("created_by_id");

-- CreateIndex
CREATE INDEX "script_versions_reviewed_by_id_idx" ON "script_versions"("reviewed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "script_versions_content_item_id_version_key" ON "script_versions"("content_item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "script_versions_content_item_id_id_key" ON "script_versions"("content_item_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "script_versions_project_id_id_key" ON "script_versions"("project_id", "id");

-- CreateIndex
CREATE INDEX "storyboard_versions_script_version_id_idx" ON "storyboard_versions"("script_version_id");

-- CreateIndex
CREATE INDEX "storyboard_versions_generation_job_id_idx" ON "storyboard_versions"("generation_job_id");

-- CreateIndex
CREATE INDEX "storyboard_versions_created_by_id_idx" ON "storyboard_versions"("created_by_id");

-- CreateIndex
CREATE INDEX "storyboard_versions_reviewed_by_id_idx" ON "storyboard_versions"("reviewed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_versions_content_item_id_version_key" ON "storyboard_versions"("content_item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_versions_content_item_id_id_key" ON "storyboard_versions"("content_item_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_versions_project_id_id_key" ON "storyboard_versions"("project_id", "id");

-- CreateIndex
CREATE INDEX "storyboard_scenes_character_version_id_idx" ON "storyboard_scenes"("character_version_id");

-- CreateIndex
CREATE INDEX "storyboard_scenes_environment_version_id_idx" ON "storyboard_scenes"("environment_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_scenes_storyboard_version_id_scene_number_key" ON "storyboard_scenes"("storyboard_version_id", "scene_number");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_scenes_project_id_id_key" ON "storyboard_scenes"("project_id", "id");

-- CreateIndex
CREATE INDEX "storyboard_scene_assets_asset_id_idx" ON "storyboard_scene_assets"("asset_id");

-- CreateIndex
CREATE INDEX "ai_task_routes_model_id_idx" ON "ai_task_routes"("model_id");

-- CreateIndex
CREATE INDEX "ai_invocations_generation_job_id_idx" ON "ai_invocations"("generation_job_id");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_id_approved_script_version_id_fkey" FOREIGN KEY ("id", "approved_script_version_id") REFERENCES "script_versions"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_id_approved_storyboard_version_id_fkey" FOREIGN KEY ("id", "approved_storyboard_version_id") REFERENCES "storyboard_versions"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_project_id_generation_job_id_fkey" FOREIGN KEY ("project_id", "generation_job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_production_run_id_fkey" FOREIGN KEY ("project_id", "production_run_id") REFERENCES "production_runs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_result_script_version_id_fkey" FOREIGN KEY ("project_id", "result_script_version_id") REFERENCES "script_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_result_storyboard_version_id_fkey" FOREIGN KEY ("project_id", "result_storyboard_version_id") REFERENCES "storyboard_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_project_id_job_id_fkey" FOREIGN KEY ("project_id", "job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_content_item_id_based_on_version_id_fkey" FOREIGN KEY ("content_item_id", "based_on_version_id") REFERENCES "script_versions"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_project_id_generation_job_id_fkey" FOREIGN KEY ("project_id", "generation_job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_content_item_id_script_version_id_fkey" FOREIGN KEY ("content_item_id", "script_version_id") REFERENCES "script_versions"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_content_item_id_based_on_version_id_fkey" FOREIGN KEY ("content_item_id", "based_on_version_id") REFERENCES "storyboard_versions"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_project_id_generation_job_id_fkey" FOREIGN KEY ("project_id", "generation_job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_versions" ADD CONSTRAINT "storyboard_versions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_scenes" ADD CONSTRAINT "storyboard_scenes_project_id_storyboard_version_id_fkey" FOREIGN KEY ("project_id", "storyboard_version_id") REFERENCES "storyboard_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_scenes" ADD CONSTRAINT "storyboard_scenes_project_id_character_version_id_fkey" FOREIGN KEY ("project_id", "character_version_id") REFERENCES "character_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_scenes" ADD CONSTRAINT "storyboard_scenes_project_id_environment_version_id_fkey" FOREIGN KEY ("project_id", "environment_version_id") REFERENCES "environment_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_scene_assets" ADD CONSTRAINT "storyboard_scene_assets_project_id_scene_id_fkey" FOREIGN KEY ("project_id", "scene_id") REFERENCES "storyboard_scenes"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storyboard_scene_assets" ADD CONSTRAINT "storyboard_scene_assets_project_id_asset_id_fkey" FOREIGN KEY ("project_id", "asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_task_routes" ADD CONSTRAINT "ai_task_routes_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_task_routes" ADD CONSTRAINT "ai_task_routes_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- =============================================================================
-- M3 integrity layer (docs/design/M3-design-review-package.md §4.3, ADR-0013).
-- Hand-written; Prisma does not model CHECKs, functions or triggers.
--   AC012  script/storyboard versions, scenes and scene assets are immutable after insert,
--          except one review (pending_review -> approved/rejected with reviewer and time).
--   AC013  approval pointers on content_items reference approved versions of that item, and
--          the storyboard pointer's script is the item's approved script (staleness gate).
--   AC011  (reused) job events are append-only; job/run identity is immutable; terminal jobs
--          never change.
-- Lock order (ADR-0011 §6): approval locks the VERSION row, then the content item (PARENT).
-- =============================================================================

ALTER TABLE "script_versions"
  ADD CONSTRAINT "script_versions_version_positive" CHECK ("version" >= 1 AND "schema_version" >= 1),
  ADD CONSTRAINT "script_versions_content_object" CHECK (jsonb_typeof("content") = 'object'),
  ADD CONSTRAINT "script_versions_review_consistent" CHECK (
    ("status" = 'pending_review') = ("reviewed_at" IS NULL)
    AND ("reviewed_at" IS NULL) = ("reviewed_by_id" IS NULL)
    AND ("review_note" IS NULL OR "reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "script_versions_source_consistent" CHECK (
    ("source" = 'generated') = ("generation_job_id" IS NOT NULL)
    AND ("source" <> 'edited' OR ("based_on_version_id" IS NOT NULL AND "created_by_id" IS NOT NULL))),
  ADD CONSTRAINT "script_versions_not_based_on_self" CHECK ("based_on_version_id" IS DISTINCT FROM "id");

ALTER TABLE "storyboard_versions"
  ADD CONSTRAINT "storyboard_versions_version_positive" CHECK ("version" >= 1 AND "schema_version" >= 1),
  ADD CONSTRAINT "storyboard_versions_duration_positive" CHECK ("total_duration_seconds" > 0),
  ADD CONSTRAINT "storyboard_versions_review_consistent" CHECK (
    ("status" = 'pending_review') = ("reviewed_at" IS NULL)
    AND ("reviewed_at" IS NULL) = ("reviewed_by_id" IS NULL)
    AND ("review_note" IS NULL OR "reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "storyboard_versions_source_consistent" CHECK (
    ("source" = 'generated') = ("generation_job_id" IS NOT NULL)
    AND ("source" <> 'edited' OR ("based_on_version_id" IS NOT NULL AND "created_by_id" IS NOT NULL))),
  ADD CONSTRAINT "storyboard_versions_not_based_on_self" CHECK ("based_on_version_id" IS DISTINCT FROM "id");

ALTER TABLE "storyboard_scenes"
  ADD CONSTRAINT "storyboard_scenes_number_positive" CHECK ("scene_number" >= 1),
  ADD CONSTRAINT "storyboard_scenes_duration_positive" CHECK ("duration_seconds" > 0);

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_attempts_bounded" CHECK (
    "max_attempts" BETWEEN 1 AND 10 AND "attempt" BETWEEN 0 AND "max_attempts"),
  -- One active job per content item and kind: active_key is set exactly while queued/running.
  ADD CONSTRAINT "generation_jobs_active_key_consistent" CHECK (
    ("status" IN ('queued', 'running')) = ("active_key" IS NOT NULL)
    AND ("active_key" IS NULL OR "active_key" = "content_item_id"::text || ':' || "kind"::text)),
  ADD CONSTRAINT "generation_jobs_completion_consistent" CHECK (
    ("status" IN ('succeeded', 'failed', 'canceled')) = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT "generation_jobs_error_consistent" CHECK ("status" <> 'failed' OR "error_code" IS NOT NULL),
  -- A succeeded job links exactly the result of its kind; other jobs link none.
  ADD CONSTRAINT "generation_jobs_result_consistent" CHECK (
    CASE WHEN "status" = 'succeeded' THEN
      ("kind" = 'script_generation' AND "result_script_version_id" IS NOT NULL AND "result_storyboard_version_id" IS NULL)
      OR ("kind" = 'storyboard_generation' AND "result_storyboard_version_id" IS NOT NULL AND "result_script_version_id" IS NULL)
    ELSE "result_script_version_id" IS NULL AND "result_storyboard_version_id" IS NULL END),
  ADD CONSTRAINT "generation_jobs_input_object" CHECK (jsonb_typeof("input") = 'object'),
  ADD CONSTRAINT "generation_jobs_execution_key_format" CHECK ("execution_key" ~ '^[0-9a-f]{64}$');

ALTER TABLE "production_runs"
  ADD CONSTRAINT "production_runs_completion_consistent" CHECK (
    ("status" IN ('succeeded', 'failed', 'canceled')) = ("completed_at" IS NOT NULL));

ALTER TABLE "job_events"
  ADD CONSTRAINT "job_events_attempt_nonnegative" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "job_events_detail_object" CHECK (jsonb_typeof("detail") = 'object');

-- ---------------------------------------------------------------- versions (AC012, AC013)

CREATE FUNCTION acf_artifact_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_cols text[] := ARRAY['status', 'reviewed_by_id', 'reviewed_at', 'review_note'];
  approved_script uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = format('%s rows cannot be deleted', TG_TABLE_NAME);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_review' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = format('%s rows are inserted as pending_review', TG_TABLE_NAME);
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending_review' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012',
      MESSAGE = format('%s %s is %s and cannot be changed', TG_TABLE_NAME, OLD.id, OLD.status);
  END IF;
  IF NEW.status = 'pending_review' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'versions are immutable; edits create a new version';
  END IF;
  IF (to_jsonb(NEW) - review_cols) IS DISTINCT FROM (to_jsonb(OLD) - review_cols) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'versions are immutable; edits create a new version';
  END IF;
  -- Gate 2: only a storyboard of the item's approved script can be approved (stale otherwise).
  -- Locks the PARENT after the VERSION (global lock order).
  IF TG_TABLE_NAME = 'storyboard_versions' AND NEW.status = 'approved' THEN
    SELECT approved_script_version_id INTO approved_script
      FROM content_items WHERE id = NEW.content_item_id FOR SHARE;
    IF approved_script IS DISTINCT FROM NEW.script_version_id THEN
      RAISE EXCEPTION USING ERRCODE = 'AC013',
        MESSAGE = 'the storyboard is stale: its script is not the approved script';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER script_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "script_versions"
  FOR EACH ROW EXECUTE FUNCTION acf_artifact_version_guard();
CREATE TRIGGER storyboard_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "storyboard_versions"
  FOR EACH ROW EXECUTE FUNCTION acf_artifact_version_guard();

-- Scenes and their asset links belong to one storyboard version: added only while it is
-- pending_review (in practice: in the transaction that creates it), never changed.
CREATE FUNCTION acf_artifact_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status artifact_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = format('%s rows are immutable', TG_TABLE_NAME);
  END IF;
  IF TG_TABLE_NAME = 'storyboard_scenes' THEN
    SELECT status INTO parent_status FROM storyboard_versions WHERE id = NEW.storyboard_version_id;
  ELSE
    SELECT v.status INTO parent_status
      FROM storyboard_scenes s JOIN storyboard_versions v ON v.id = s.storyboard_version_id
      WHERE s.id = NEW.scene_id;
  END IF;
  IF parent_status IS DISTINCT FROM 'pending_review' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'a reviewed storyboard version cannot gain scenes';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER storyboard_scenes_guard BEFORE INSERT OR UPDATE OR DELETE ON "storyboard_scenes"
  FOR EACH ROW EXECUTE FUNCTION acf_artifact_child_guard();
CREATE TRIGGER storyboard_scene_assets_guard BEFORE INSERT OR UPDATE OR DELETE ON "storyboard_scene_assets"
  FOR EACH ROW EXECUTE FUNCTION acf_artifact_child_guard();

-- Approval pointers (Q3). The composite FKs keep each pointer within its content item.
CREATE FUNCTION acf_content_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st artifact_status;
  sb_script uuid;
BEGIN
  IF NEW.approved_script_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.approved_script_version_id IS DISTINCT FROM OLD.approved_script_version_id) THEN
    SELECT status INTO st FROM script_versions WHERE id = NEW.approved_script_version_id;
    IF st IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC013', MESSAGE = 'the approved-script pointer must reference an approved script';
    END IF;
  END IF;
  IF NEW.approved_storyboard_version_id IS NOT NULL THEN
    SELECT status, script_version_id INTO st, sb_script
      FROM storyboard_versions WHERE id = NEW.approved_storyboard_version_id;
    IF st IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION USING ERRCODE = 'AC013', MESSAGE = 'the approved-storyboard pointer must reference an approved storyboard';
    END IF;
    IF sb_script IS DISTINCT FROM NEW.approved_script_version_id THEN
      RAISE EXCEPTION USING ERRCODE = 'AC013', MESSAGE = 'the approved storyboard must belong to the approved script';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER content_items_pointer_guard
  BEFORE INSERT OR UPDATE OF approved_script_version_id, approved_storyboard_version_id ON "content_items"
  FOR EACH ROW EXECUTE FUNCTION acf_content_pointer_guard();

-- ---------------------------------------------------------------- jobs and runs (AC011)

CREATE FUNCTION acf_generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_cols text[] := ARRAY['id', 'project_id', 'content_item_id', 'production_run_id', 'kind',
    'idempotency_key', 'execution_key', 'input', 'previous_content_status', 'prompt_template_id',
    'model_id', 'max_attempts', 'requested_by_id', 'queued_at'];
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

CREATE TRIGGER generation_jobs_guard BEFORE INSERT OR UPDATE OR DELETE ON "generation_jobs"
  FOR EACH ROW EXECUTE FUNCTION acf_generation_job_guard();

CREATE FUNCTION acf_production_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'production_runs rows cannot be deleted';
  END IF;
  IF (NEW.id, NEW.project_id, NEW.content_item_id, NEW.requested_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.content_item_id, OLD.requested_by_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'production_runs identity columns are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER production_runs_guard BEFORE UPDATE OR DELETE ON "production_runs"
  FOR EACH ROW EXECUTE FUNCTION acf_production_run_guard();

CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON "job_events"
  FOR EACH ROW EXECUTE FUNCTION acf_ai_ledger_append_only();
