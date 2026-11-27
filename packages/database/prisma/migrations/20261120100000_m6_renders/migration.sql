-- M6 renders (design: docs/design/M6-design-review-package.md §4, §9). Generated DDL first, then
-- the integrity layer (CHECKs, guards, the gate-5 pointer trigger).

-- CreateEnum
CREATE TYPE "render_review_status" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "content_items" ADD COLUMN     "approved_render_id" UUID;

-- CreateTable
CREATE TABLE "renders" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "storyboard_version_id" UUID NOT NULL,
    "generation_job_id" UUID NOT NULL,
    "manifest" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "execution_key" CHAR(64) NOT NULL,
    "video_asset_id" UUID,
    "subtitle_asset_id" UUID,
    "thumbnail_asset_id" UUID,
    "duration_ms" INTEGER,
    "upscaled_from" VARCHAR(16),
    "qc" JSONB,
    "review_status" "render_review_status" NOT NULL DEFAULT 'pending',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(2000),
    "exported_at" TIMESTAMPTZ(3),
    "exported_by_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "renders_content_item_id_created_at_idx" ON "renders"("content_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "renders_storyboard_version_id_idx" ON "renders"("storyboard_version_id");

-- CreateIndex
CREATE INDEX "renders_video_asset_id_idx" ON "renders"("video_asset_id");

-- CreateIndex
CREATE INDEX "renders_subtitle_asset_id_idx" ON "renders"("subtitle_asset_id");

-- CreateIndex
CREATE INDEX "renders_thumbnail_asset_id_idx" ON "renders"("thumbnail_asset_id");

-- CreateIndex
CREATE INDEX "renders_reviewed_by_id_idx" ON "renders"("reviewed_by_id");

-- CreateIndex
CREATE INDEX "renders_exported_by_id_idx" ON "renders"("exported_by_id");

-- CreateIndex
CREATE INDEX "renders_created_by_id_idx" ON "renders"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "renders_project_id_id_key" ON "renders"("project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "renders_content_item_id_id_key" ON "renders"("content_item_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "renders_project_id_generation_job_id_key" ON "renders"("project_id", "generation_job_id");

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_id_approved_render_id_fkey" FOREIGN KEY ("id", "approved_render_id") REFERENCES "renders"("content_item_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_content_item_id_fkey" FOREIGN KEY ("project_id", "content_item_id") REFERENCES "content_items"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_storyboard_version_id_fkey" FOREIGN KEY ("project_id", "storyboard_version_id") REFERENCES "storyboard_versions"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_generation_job_id_fkey" FOREIGN KEY ("project_id", "generation_job_id") REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_video_asset_id_fkey" FOREIGN KEY ("project_id", "video_asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_subtitle_asset_id_fkey" FOREIGN KEY ("project_id", "subtitle_asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_thumbnail_asset_id_fkey" FOREIGN KEY ("project_id", "thumbnail_asset_id") REFERENCES "assets"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_exported_by_id_fkey" FOREIGN KEY ("exported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- lineage

-- A render's inputs: the clips, voice-overs and music it assembled (the thumbnail's source is the
-- keyframe role from M5).
ALTER TABLE "asset_inputs" DROP CONSTRAINT "asset_inputs_role_known";
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_role_known"
  CHECK ("role" IN ('character', 'environment', 'scene_reference', 'keyframe', 'clip', 'voiceover', 'music'));

-- ---------------------------------------------------------------- renders

ALTER TABLE "renders"
  ADD CONSTRAINT "renders_manifest_object" CHECK (jsonb_typeof("manifest") = 'object'),
  ADD CONSTRAINT "renders_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
  ADD CONSTRAINT "renders_qc_object" CHECK ("qc" IS NULL OR jsonb_typeof("qc") = 'object'),
  ADD CONSTRAINT "renders_execution_key_format" CHECK ("execution_key" ~ '^[0-9a-f]{64}$'),
  -- The outputs of a succeeded render exist together.
  ADD CONSTRAINT "renders_outputs_together" CHECK (
    ("video_asset_id" IS NULL) = ("subtitle_asset_id" IS NULL)
    AND ("video_asset_id" IS NULL) = ("thumbnail_asset_id" IS NULL)
    AND ("video_asset_id" IS NULL) = ("duration_ms" IS NULL)),
  ADD CONSTRAINT "renders_duration_positive" CHECK ("duration_ms" IS NULL OR "duration_ms" > 0),
  -- Gate 5: only a render with outputs is reviewed; a decision records who and when.
  ADD CONSTRAINT "renders_review_consistent" CHECK (
    ("review_status" = 'pending') = ("reviewed_by_id" IS NULL)
    AND ("reviewed_by_id" IS NULL) = ("reviewed_at" IS NULL)
    AND ("review_status" = 'pending' OR "video_asset_id" IS NOT NULL)),
  ADD CONSTRAINT "renders_review_note_nonempty" CHECK ("review_note" IS NULL OR length(btrim("review_note")) > 0),
  -- Only an approved render is exported.
  ADD CONSTRAINT "renders_export_consistent" CHECK (
    ("exported_at" IS NULL) = ("exported_by_id" IS NULL)
    AND ("exported_at" IS NULL OR "review_status" = 'approved'));

-- What was rendered never changes; outputs, QC, the review and the export are each set once.
CREATE FUNCTION acf_render_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen text[] := ARRAY['id', 'project_id', 'content_item_id', 'storyboard_version_id',
    'generation_job_id', 'manifest', 'settings', 'execution_key', 'upscaled_from',
    'created_by_id', 'created_at'];
  once text[] := ARRAY['video_asset_id', 'subtitle_asset_id', 'thumbnail_asset_id', 'duration_ms', 'qc'];
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'renders are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.review_status <> 'pending' OR NEW.exported_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'a render is created unreviewed';
    END IF;
    RETURN NEW;
  END IF;
  FOREACH k IN ARRAY frozen LOOP
    IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = format('renders.%s is immutable', k);
    END IF;
  END LOOP;
  FOREACH k IN ARRAY once LOOP
    IF (to_jsonb(OLD) -> k) <> 'null'::jsonb AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
      RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = format('renders.%s is set once', k);
    END IF;
  END LOOP;
  IF OLD.review_status <> 'pending'
     AND (NEW.review_status, NEW.reviewed_by_id, NEW.reviewed_at, NEW.review_note)
         IS DISTINCT FROM (OLD.review_status, OLD.reviewed_by_id, OLD.reviewed_at, OLD.review_note) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'a render is reviewed once';
  END IF;
  IF OLD.exported_at IS NOT NULL
     AND (NEW.exported_at, NEW.exported_by_id) IS DISTINCT FROM (OLD.exported_at, OLD.exported_by_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC012', MESSAGE = 'a render is exported once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER renders_guard BEFORE INSERT OR UPDATE OR DELETE ON "renders"
  FOR EACH ROW EXECUTE FUNCTION acf_render_guard();

-- Gate 5 (AC017): the approved-render pointer names an approved render of the same item (the
-- composite FK guarantees the item). The render is read FOR SHARE; reviews never revert.
CREATE FUNCTION acf_render_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  status text;
BEGIN
  IF NEW.approved_render_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.approved_render_id IS NOT DISTINCT FROM OLD.approved_render_id) THEN
    RETURN NEW;
  END IF;
  SELECT review_status::text INTO status FROM renders WHERE id = NEW.approved_render_id FOR SHARE;
  IF status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC017', MESSAGE = 'the approved render must be an approved render of this content item';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER content_items_render_pointer_guard BEFORE INSERT OR UPDATE OF approved_render_id ON "content_items"
  FOR EACH ROW EXECUTE FUNCTION acf_render_pointer_guard();
