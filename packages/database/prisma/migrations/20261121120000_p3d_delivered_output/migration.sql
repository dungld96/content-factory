-- P3d: keep paid media when a later step fails (docs/design/P3d-design-review-package.md).
-- A clip or voice-over is written to its final object key as soon as the provider delivers it,
-- before FFprobe checks it; the job records where. A "finish" job (recover_from_job_id) later
-- validates that file and creates the asset without calling the provider again.
ALTER TABLE "generation_jobs"
  ADD COLUMN "delivered_at" TIMESTAMPTZ(3),
  ADD COLUMN "staged_asset_id" UUID,
  ADD COLUMN "staged_object_key" VARCHAR(500),
  ADD COLUMN "staged_sha256" CHAR(64),
  ADD COLUMN "staged_mime_type" VARCHAR(100),
  ADD COLUMN "recover_from_job_id" UUID;

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_project_id_recover_from_job_id_fkey"
    FOREIGN KEY ("project_id", "recover_from_job_id")
    REFERENCES "generation_jobs"("project_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "generation_jobs_delivery_media_only"
    CHECK ("delivered_at" IS NULL OR "kind" IN ('video_generation', 'tts_generation')),
  ADD CONSTRAINT "generation_jobs_staged_complete"
    CHECK (("staged_object_key" IS NULL AND "staged_asset_id" IS NULL AND "staged_sha256" IS NULL
            AND "staged_mime_type" IS NULL)
        OR ("staged_object_key" IS NOT NULL AND "staged_asset_id" IS NOT NULL
            AND "staged_sha256" ~ '^[0-9a-f]{64}$' AND "staged_mime_type" IS NOT NULL
            AND "delivered_at" IS NOT NULL)),
  ADD CONSTRAINT "generation_jobs_recover_media_only"
    CHECK ("recover_from_job_id" IS NULL OR "kind" IN ('video_generation', 'tts_generation')),
  ADD CONSTRAINT "generation_jobs_recover_not_self"
    CHECK ("recover_from_job_id" IS NULL OR "recover_from_job_id" <> "id");

CREATE INDEX "generation_jobs_recover_from_job_id_idx" ON "generation_jobs"("recover_from_job_id");

-- M5 guard + P3d: recover_from_job_id is identity; delivery columns are write-once.
CREATE OR REPLACE FUNCTION acf_generation_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_cols text[] := ARRAY['id', 'project_id', 'content_item_id', 'production_run_id', 'kind',
    'idempotency_key', 'execution_key', 'input', 'previous_content_status', 'prompt_template_id',
    'model_id', 'max_attempts', 'requested_by_id', 'queued_at', 'storyboard_scene_id',
    'recover_from_job_id'];
  -- P3d: what the provider delivered is recorded once and never rewritten.
  delivered_cols text[] := ARRAY['delivered_at', 'staged_asset_id', 'staged_object_key',
    'staged_sha256', 'staged_mime_type'];
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
  IF OLD.delivered_at IS NOT NULL THEN
    FOREACH k IN ARRAY delivered_cols LOOP
      IF (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k) THEN
        RAISE EXCEPTION USING ERRCODE = 'AC011',
          MESSAGE = format('generation_jobs.%s is frozen once the output is delivered', k);
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
