-- M4b: image generation in the AI registry (docs/design/M4-design-review-package.md §3.3, §6;
-- verification record docs/design/m4/openrouter-image-verification.md). Additive only.

-- AlterEnum


ALTER TYPE "ai_price_metric" ADD VALUE 'output_images';
ALTER TYPE "ai_price_metric" ADD VALUE 'input_images';
ALTER TYPE "ai_price_metric" ADD VALUE 'output_pixels';
ALTER TYPE "ai_price_metric" ADD VALUE 'input_pixels';
ALTER TYPE "ai_price_metric" ADD VALUE 'output_image_tokens';
ALTER TYPE "ai_price_metric" ADD VALUE 'input_image_tokens';

-- AlterEnum
ALTER TYPE "generation_job_kind" ADD VALUE 'image_generation';

-- DropIndex
DROP INDEX "ai_model_prices_model_id_metric_min_prompt_tokens_effective_key";

-- AlterTable
ALTER TABLE "ai_model_prices" ADD COLUMN     "variant" VARCHAR(32) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "image_constraints" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_prices_model_id_metric_min_prompt_tokens_variant_e_key" ON "ai_model_prices"("model_id", "metric", "min_prompt_tokens", "variant", "effective_from");


-- A price tier name is short, lowercase and trimmed ("" = applies to every request).
ALTER TABLE "ai_model_prices"
  ADD CONSTRAINT "ai_model_prices_variant_format" CHECK ("variant" ~ '^[a-z0-9._-]{0,32}$');

ALTER TABLE "ai_models"
  ADD CONSTRAINT "ai_models_image_constraints_object"
  CHECK ("image_constraints" IS NULL OR jsonb_typeof("image_constraints") = 'object');
