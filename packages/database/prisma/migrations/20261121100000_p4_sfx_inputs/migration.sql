-- P4 S3: sound effects are render inputs (design: docs/design/P4-design-review-package.md §4).
ALTER TABLE "asset_inputs" DROP CONSTRAINT "asset_inputs_role_known";
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_role_known"
  CHECK ("role" IN ('character', 'environment', 'scene_reference', 'keyframe', 'clip', 'voiceover', 'music', 'sfx'));
