-- M5b: video and TTS in the AI registry (docs/design/M5-design-review-package.md §3.3, §4.2, §9;
-- verification record docs/design/m5/openrouter-video-tts-verification.md). Additive only.

-- AlterEnum
ALTER TYPE "ai_price_metric" ADD VALUE 'output_video_seconds';
ALTER TYPE "ai_price_metric" ADD VALUE 'output_video_tokens';
ALTER TYPE "ai_price_metric" ADD VALUE 'input_characters';

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "media_constraints" JSONB;

ALTER TABLE "ai_models"
  ADD CONSTRAINT "ai_models_media_constraints_kind"
  CHECK (
    "media_constraints" IS NULL
    OR (jsonb_typeof("media_constraints") = 'object'
        AND "media_constraints"->>'kind' IN ('video', 'tts'))
  );
