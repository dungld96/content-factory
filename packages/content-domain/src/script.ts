import { z } from 'zod';

import type { RuleIssue } from './issues.js';

/** Schema version stored with every script version (M3 design §5.2). */
export const SCRIPT_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Script output, content plan included (decision F3). Strict: every field is required so the JSON
 * Schema works with providers' strict structured-output mode; lists may be empty where noted.
 */
export const scriptContentSchema = z.strictObject({
  title: text(120),
  plan: z.strictObject({
    angle: text(500),
    audienceInsight: text(500),
    hookOptions: z.array(text(300)).min(1).max(3),
    keyMessage: text(500),
    callToAction: text(300),
    estimatedSceneCount: z.number().int().min(1).max(12),
  }),
  hook: text(300),
  /** Full narration. */
  voiceOver: text(6000),
  onScreenText: z.array(text(200)).max(30),
  sceneOutline: z
    .array(
      z.strictObject({
        order: z.number().int().min(1).max(12),
        summary: text(500),
        approxSeconds: z.number().positive().max(600),
      }),
    )
    .min(1)
    .max(12),
  callToAction: text(300),
  /** Empty when no factual claim needs checking. */
  claimsRequiringVerification: z
    .array(z.strictObject({ claim: text(500), reason: text(500) }))
    .max(20),
  /** Only URLs from the brief (anti-fabrication, decision F2). Empty when none was used. */
  sources: z.array(z.strictObject({ url: z.url().max(2048), usedFor: text(300) })).max(20),
});
export type ScriptContent = z.infer<typeof scriptContentSchema>;

export interface ScriptRuleContext {
  /** URLs the brief supplied; the script may cite nothing else. */
  readonly allowedSourceUrls: readonly string[];
}

/** Domain rules beyond the schema (M3 design §5.2, §7.4 step 5). */
export function scriptRuleIssues(script: ScriptContent, ctx: ScriptRuleContext): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const allowed = new Set(ctx.allowedSourceUrls);
  script.sources.forEach((source, i) => {
    if (!allowed.has(source.url)) {
      issues.push({
        path: `sources.${String(i)}.url`,
        message: 'not one of the source URLs supplied in the brief',
      });
    }
  });
  const orders = script.sceneOutline.map((s) => s.order);
  const expected = orders.map((_, i) => i + 1);
  if (orders.join(',') !== expected.join(',')) {
    issues.push({ path: 'sceneOutline', message: 'order must be 1..n in sequence' });
  }
  return issues;
}
