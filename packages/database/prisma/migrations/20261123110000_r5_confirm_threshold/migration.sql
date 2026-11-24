-- Redesign R-D4: configurable cost-confirmation threshold (docs/design/R-redesign-package.md §5).
CREATE TABLE "workspace_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "confirm_threshold_usd" DECIMAL(14,6) NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_settings_singleton" CHECK ("id" = 1),
    CONSTRAINT "workspace_settings_threshold_range" CHECK ("confirm_threshold_usd" >= 0 AND "confirm_threshold_usd" <= 1000)
);
CREATE INDEX "workspace_settings_updated_by_id_idx" ON "workspace_settings"("updated_by_id");
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_budgets" ADD COLUMN "confirm_threshold_usd" DECIMAL(14,6);
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_threshold_range"
  CHECK ("confirm_threshold_usd" IS NULL OR ("confirm_threshold_usd" >= 0 AND "confirm_threshold_usd" <= 1000));

-- Redesign R-D5: the live job tailer reads new job events by time.
CREATE INDEX "job_events_created_at_idx" ON "job_events"("created_at");
