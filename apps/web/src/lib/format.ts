import type { ContentItemDto } from '@acf/contracts';

type Platform = NonNullable<ContentItemDto['targetPlatform']>;

export const PLATFORM_OPTIONS: readonly { readonly value: Platform; readonly label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram_reels', label: 'Instagram Reels' },
  { value: 'youtube_shorts', label: 'YouTube Shorts' },
  { value: 'other', label: 'Other' },
];

export function platformLabel(platform: Platform | null): string {
  return PLATFORM_OPTIONS.find((p) => p.value === platform)?.label ?? 'No platform';
}

export const FORMAT_LABEL: Readonly<Record<ContentItemDto['format'], string>> = {
  short_video: 'Short video',
};

/** "30s · 9:16 · VI" (prototype specification column). */
export function specLabel(item: {
  readonly targetDurationSeconds: number;
  readonly aspectRatio: string;
  readonly language: string;
}): string {
  return `${String(item.targetDurationSeconds)}s · ${item.aspectRatio} · ${item.language.toUpperCase()}`;
}

/** Up to two initials of a name ("Demo Studio" → "DS"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const [first = '', second] = words;
  const letters = second === undefined ? first.slice(0, 2) : `${first[0] ?? ''}${second[0] ?? ''}`;
  return letters.toUpperCase() || '?';
}

/** One of six logo palettes, stable per id (decoration only). */
export function paletteIndex(id: string, size = 6): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % size;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** "4.2 s" from milliseconds (media durations). */
export function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
}

/**
 * What a media job's error code means for the user and what they can do (M5 design §5.4).
 * Unknown codes fall back to the code itself.
 */
export function jobErrorText(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    SUBMIT_OUTCOME_UNKNOWN:
      'The submission could not be confirmed. Regenerating may be charged twice.',
    PROVIDER_TIMEOUT: 'The provider did not finish in time; it may still charge.',
    PROVIDER_FAILED: 'The provider failed to generate the clip. Regenerate the scene.',
    PROVIDER_CANCELLED: 'The provider cancelled the job. Regenerate the scene.',
    PROVIDER_EXPIRED: 'The provider expired the job. Regenerate the scene.',
    OUTPUT_INVALID: 'The file failed validation. Regenerate the scene.',
    OUTPUT_EXPIRED: 'The provider deleted the output before download. Regenerate the scene.',
    INSUFFICIENT_CREDITS: 'Provider credits are exhausted. Top up, then regenerate.',
    CONTENT_POLICY: 'Blocked by the provider’s content policy. Change the prompt or keyframe.',
    INVALID_REQUEST: 'The model does not support these parameters. Pick another model.',
    AUTH: 'The provider rejected the API key. Ask an operator to check it.',
    MEDIA_TOOLS_MISSING: 'FFprobe is not installed on the worker. Ask an operator.',
    CANCELED_BY_USER: 'Canceled; the provider may still charge.',
  };
  return messages[code] ?? code;
}
