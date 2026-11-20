-- M8.5 Q2: per-model structured-output mode (design: docs/design/M8.5-design-review-package.md §3).
-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "schema_mode" VARCHAR(8) NOT NULL DEFAULT 'full';


ALTER TABLE "ai_models"
  ADD CONSTRAINT "ai_models_schema_mode_known" CHECK ("schema_mode" IN ('full', 'basic'));
