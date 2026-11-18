import { CONTENT_FORMATS, type AspectRatio, type ContentFormat } from './formats.js';
import type { RuleIssue } from './issues.js';

/**
 * Publishing platforms: where a deliverable goes, and therefore its constraints (M3.5 review
 * §2.1, AD-4). Mirrors the database enum `channel_platform`. A platform never changes the
 * pipeline; it only adds limits and defaults.
 */
export const CHANNEL_PLATFORMS = ['tiktok', 'instagram_reels', 'youtube_shorts', 'other'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/** How a platform fact was established. Facts without a basis are not recorded at all. */
export type PlatformFactBasis =
  /** Read on the platform's own help/documentation page. */
  | 'official_page'
  /** Text of the official page as quoted by a search engine; the page itself was not fetched. */
  | 'official_page_excerpt';

export interface PlatformFact<T> {
  readonly value: T;
  readonly basis: PlatformFactBasis;
  readonly sourceUrl: string;
  /** UTC date the fact was checked (YYYY-MM-DD). Re-check before relying on it for publishing. */
  readonly verifiedAt: string;
}

export interface PlatformProfile {
  readonly platform: ChannelPlatform;
  readonly label: string;
  /** Formats this platform accepts (the format × platform compatibility matrix). */
  readonly formats: readonly ContentFormat[];
  /** Unset when no verified figure exists: unknown limits are never enforced or guessed. */
  readonly maxDurationSeconds?: PlatformFact<number>;
  readonly aspectRatios?: PlatformFact<readonly AspectRatio[]>;
}

/**
 * Platform registry (R0). Official help pages for TikTok, Instagram and YouTube could not be
 * fetched from the build environment on 2026-11-18, so only the YouTube Shorts length — quoted
 * from the official page by a search engine — is recorded. Everything else stays unset until
 * verified on the official page.
 */
export const PLATFORM_PROFILES: Readonly<Record<ChannelPlatform, PlatformProfile>> = {
  tiktok: { platform: 'tiktok', label: 'TikTok', formats: ['short_video'] },
  instagram_reels: {
    platform: 'instagram_reels',
    label: 'Instagram Reels',
    formats: ['short_video'],
  },
  youtube_shorts: {
    platform: 'youtube_shorts',
    label: 'YouTube Shorts',
    formats: ['short_video'],
    maxDurationSeconds: {
      value: 180,
      basis: 'official_page_excerpt',
      sourceUrl: 'https://support.google.com/youtube/answer/15424877',
      verifiedAt: '2026-11-18',
    },
  },
  /** Any other destination: no constraints, every format. */
  other: { platform: 'other', label: 'Other', formats: CONTENT_FORMATS },
};

export function platformProfile(platform: ChannelPlatform): PlatformProfile {
  return PLATFORM_PROFILES[platform];
}

export function isFormatCompatible(format: ContentFormat, platform: ChannelPlatform): boolean {
  return PLATFORM_PROFILES[platform].formats.includes(format);
}

export interface PlatformCheckInput {
  readonly format: ContentFormat;
  readonly platform: ChannelPlatform;
  readonly targetDurationSeconds: number;
  readonly aspectRatio: string;
}

/**
 * Advisory checks of a variant's spec against its platform's verified limits. Warnings only:
 * M1–M3 accept these values today, and platform facts are dated, not guaranteed (review §6).
 */
export function platformWarnings(input: PlatformCheckInput): RuleIssue[] {
  const profile = PLATFORM_PROFILES[input.platform];
  const warnings: RuleIssue[] = [];
  if (!profile.formats.includes(input.format)) {
    warnings.push({ path: 'format', message: `${profile.label} does not accept this format` });
  }
  const max = profile.maxDurationSeconds;
  if (max && input.targetDurationSeconds > max.value) {
    warnings.push({
      path: 'targetDurationSeconds',
      message: `longer than ${String(max.value)} s, the ${profile.label} limit (checked ${max.verifiedAt})`,
    });
  }
  const ratios = profile.aspectRatios;
  if (ratios && !(ratios.value as readonly string[]).includes(input.aspectRatio)) {
    warnings.push({
      path: 'aspectRatio',
      message: `${profile.label} expects ${ratios.value.join(', ')} (checked ${ratios.verifiedAt})`,
    });
  }
  return warnings;
}
