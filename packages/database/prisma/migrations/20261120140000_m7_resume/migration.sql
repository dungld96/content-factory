-- M7 resume of production runs (design: docs/design/M7-design-review-package.md §6). Generated
-- DDL first, then the run guard extended: the link is set once.
-- AlterTable
ALTER TABLE "production_runs" ADD COLUMN     "resumed_from_run_id" UUID;

-- CreateIndex
CREATE INDEX "production_runs_resumed_from_run_id_idx" ON "production_runs"("resumed_from_run_id");

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_project_id_resumed_from_run_id_fkey" FOREIGN KEY ("project_id", "resumed_from_run_id") REFERENCES "production_runs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------- integrity layer

ALTER TABLE "production_runs"
  ADD CONSTRAINT "production_runs_not_resumed_from_self" CHECK ("resumed_from_run_id" IS DISTINCT FROM "id");

-- As before (identity immutable, never deleted), plus: the resumed-from link is set at most once.
CREATE OR REPLACE FUNCTION acf_production_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'production_runs rows cannot be deleted';
  END IF;
  IF (NEW.id, NEW.project_id, NEW.content_item_id, NEW.requested_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.content_item_id, OLD.requested_by_id, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'production_runs identity columns are immutable';
  END IF;
  IF OLD.resumed_from_run_id IS NOT NULL
     AND NEW.resumed_from_run_id IS DISTINCT FROM OLD.resumed_from_run_id THEN
    RAISE EXCEPTION USING ERRCODE = 'AC011', MESSAGE = 'a run''s resumed-from link is set once';
  END IF;
  RETURN NEW;
END $$;
