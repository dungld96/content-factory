-- M5c: video and TTS job kinds (docs/design/M5-design-review-package.md §5). A separate migration:
-- PostgreSQL forbids using a new enum value in the transaction that adds it, and m5_media's
-- CHECKs and triggers reference these values.

-- AlterEnum
ALTER TYPE "generation_job_kind" ADD VALUE 'video_generation';
ALTER TYPE "generation_job_kind" ADD VALUE 'tts_generation';
