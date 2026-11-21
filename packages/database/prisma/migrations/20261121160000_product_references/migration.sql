-- Brief product references: keyframes record the product photos they were made from
-- (docs/design/P2b-design-review-package.md §12).
ALTER TABLE "asset_inputs" DROP CONSTRAINT "asset_inputs_role_known";
ALTER TABLE "asset_inputs" ADD CONSTRAINT "asset_inputs_role_known"
  CHECK ("role" IN ('character', 'product', 'environment', 'scene_reference', 'keyframe', 'clip', 'voiceover', 'music', 'sfx'));
