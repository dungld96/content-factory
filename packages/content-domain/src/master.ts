import { canonicalJson } from './execution-key.js';
import type { ChannelPlatform } from './platforms.js';

/**
 * Content masters and variants (M3.5 review §3, ADR-0015). A master holds the shared brief; a
 * variant (a content item) copies it at creation and may diverge. The master's
 * `brief_revision` grows with every brief change; a variant records the revision it copied.
 */

/** The first brief revision of a master (and of a variant's copy). */
export const INITIAL_BRIEF_REVISION = 1;

/** True when two briefs differ in content (key order and `undefined` fields are ignored). */
export function briefChanged(before: unknown, after: unknown): boolean {
  return canonicalJson(before) !== canonicalJson(after);
}

/** The master's brief revision after an edit: unchanged when the brief content is unchanged. */
export function nextBriefRevision(current: number, before: unknown, after: unknown): number {
  return briefChanged(before, after) ? current + 1 : current;
}

/** A variant is stale when its master's brief changed after the variant copied it. */
export function isMasterBriefStale(variantRevision: number, masterRevision: number): boolean {
  return variantRevision < masterRevision;
}

export type VariantPlatformResult =
  | { readonly ok: true; readonly platform: ChannelPlatform | null }
  | { readonly ok: false; readonly code: 'PLATFORM_CHANNEL_MISMATCH' };

/**
 * The variant's effective target platform (owner decision, review §8): the channel's platform
 * when a channel is set — an explicit `targetPlatform` must then match it — otherwise the
 * explicit `targetPlatform`, or none.
 */
export function resolveVariantPlatform(input: {
  readonly channelPlatform: ChannelPlatform | null;
  readonly targetPlatform: ChannelPlatform | null | undefined;
}): VariantPlatformResult {
  const { channelPlatform, targetPlatform } = input;
  if (channelPlatform !== null) {
    if (targetPlatform != null && targetPlatform !== channelPlatform) {
      return { ok: false, code: 'PLATFORM_CHANNEL_MISMATCH' };
    }
    return { ok: true, platform: channelPlatform };
  }
  return { ok: true, platform: targetPlatform ?? null };
}
