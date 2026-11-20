import { z } from 'zod';

import type { RuleIssue } from './issues.js';

/** Schema version stored with every storyboard version (M3 design §5.3). */
export const STORYBOARD_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max);

/** One scene, exactly the fields of CONTENT_PIPELINE stage 5. */
export const storyboardSceneSchema = z.strictObject({
  sceneNumber: z.number().int().min(1).max(30),
  durationSeconds: z.number().positive().max(120),
  shotType: text(100),
  cameraAngle: text(100),
  cameraMovement: text(100),
  characterAction: optionalText(1000),
  /** Approved character master version, or null for scenes without the character. */
  characterVersionId: z.uuid().nullable(),
  environmentVersionId: z.uuid().nullable(),
  visualDescription: text(2000),
  imagePrompt: text(2000),
  videoPrompt: text(2000),
  negativePrompt: optionalText(1000),
  voiceOverSegment: optionalText(2000),
  onScreenText: optionalText(300),
  requiredReferenceAssetIds: z.array(z.uuid()).max(10),
  acceptanceChecks: z.array(text(300)).max(10),
});
export type StoryboardScene = z.infer<typeof storyboardSceneSchema>;

export const storyboardContentSchema = z.strictObject({
  scenes: z.array(storyboardSceneSchema).min(1).max(30),
});
export type StoryboardContent = z.infer<typeof storyboardContentSchema>;

/** Allowed scene-duration total: target ± max(1 s, 5 % of target) (decision Q6). */
export function durationTolerance(targetSeconds: number): number {
  return Math.max(1, targetSeconds * 0.05);
}

export interface StoryboardRuleContext {
  readonly targetDurationSeconds: number;
  /** Approved master versions the prompt offered; scenes may reference nothing else. */
  readonly allowedCharacterVersionIds: readonly string[];
  readonly allowedEnvironmentVersionIds: readonly string[];
  /** Assets attached to those versions. */
  readonly allowedAssetIds: readonly string[];
  /** Clip lengths of the routed video model (M8.5 Q1); null or absent: any length. */
  readonly allowedSceneDurations?: readonly number[] | null;
}

/** Domain rules beyond the schema: numbering, total duration, ID allow-lists (M3 design §5.3). */
export function storyboardRuleIssues(
  content: StoryboardContent,
  ctx: StoryboardRuleContext,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  content.scenes.forEach((scene, i) => {
    if (scene.sceneNumber !== i + 1) {
      issues.push({ path: `scenes.${String(i)}.sceneNumber`, message: `must be ${String(i + 1)}` });
    }
    const at = (field: string) => `scenes.${String(i)}.${field}`;
    if (
      scene.characterVersionId !== null &&
      !ctx.allowedCharacterVersionIds.includes(scene.characterVersionId)
    ) {
      issues.push({ path: at('characterVersionId'), message: 'not an offered character version' });
    }
    if (
      scene.environmentVersionId !== null &&
      !ctx.allowedEnvironmentVersionIds.includes(scene.environmentVersionId)
    ) {
      issues.push({
        path: at('environmentVersionId'),
        message: 'not an offered environment version',
      });
    }
    scene.requiredReferenceAssetIds.forEach((id, j) => {
      if (!ctx.allowedAssetIds.includes(id)) {
        issues.push({
          path: at(`requiredReferenceAssetIds.${String(j)}`),
          message: 'not an offered asset',
        });
      }
    });
  });
  const allowed = ctx.allowedSceneDurations;
  if (allowed && allowed.length > 0) {
    content.scenes.forEach((scene, i) => {
      if (!allowed.includes(scene.durationSeconds)) {
        issues.push({
          path: `scenes.${String(i)}.durationSeconds`,
          message: `${String(scene.durationSeconds)} s is not a clip length; use one of ${allowed.join(', ')} s`,
        });
      }
    });
  }
  const total = totalDuration(content);
  const tolerance = durationTolerance(ctx.targetDurationSeconds);
  if (Math.abs(total - ctx.targetDurationSeconds) > tolerance) {
    issues.push({
      path: 'scenes',
      message: `durations sum to ${String(total)} s; target ${String(ctx.targetDurationSeconds)} s ± ${String(tolerance)} s`,
    });
  }
  return issues;
}

/** Sum of scene durations, rounded to centiseconds (the stored precision). */
export function totalDuration(content: StoryboardContent): number {
  const cents = content.scenes.reduce((sum, s) => sum + Math.round(s.durationSeconds * 100), 0);
  return cents / 100;
}
