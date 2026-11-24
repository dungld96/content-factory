import type { ContentItemDto } from '@acf/contracts';

import type { Locale, Translate } from './i18n';
import { jobError } from './job-errors';

type Platform = NonNullable<ContentItemDto['targetPlatform']>;

/** Platform names (brand names stay as they are; "Other" is translated). */
export function platformOptions(t: Translate): { readonly value: Platform; readonly label: string }[] {
  return [
    { value: 'tiktok', label: 'TikTok' },
    { value: 'instagram_reels', label: 'Instagram Reels' },
    { value: 'youtube_shorts', label: 'YouTube Shorts' },
    { value: 'other', label: t('platform.other') },
  ];
}

export function platformLabel(t: Translate, platform: Platform | null): string {
  return platformOptions(t).find((p) => p.value === platform)?.label ?? t('platform.none');
}

export function formatLabel(t: Translate, format: ContentItemDto['format']): string {
  return format === 'short_video' ? t('format.short_video') : format;
}

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

/** Readable text for a job error code (P3 W3: the catalogue in `job-errors.ts`). */
export function jobErrorText(code: string, locale: Locale = 'en'): string {
  return jobError(code, locale).text;
}

const JOB_KINDS = [
  'script_generation',
  'storyboard_generation',
  'image_generation',
  'video_generation',
  'tts_generation',
  'render',
] as const;

/** Stage name of a generation job kind (Operations, Activity), in the interface language. */
export function jobKindLabel(t: Translate, kind: string): string {
  return (JOB_KINDS as readonly string[]).includes(kind)
    ? t(`jobKind.${kind as (typeof JOB_KINDS)[number]}`)
    : kind;
}

/**
 * Identical lines once each, in first-seen order, with how often they occurred: a model can list
 * the same unimported price override several times (e.g. per weekday window).
 */
export function countedLines(lines: readonly string[]): { text: string; count: number }[] {
  const out: { text: string; count: number }[] = [];
  for (const text of lines) {
    const seen = out.find((l) => l.text === text);
    if (seen) seen.count += 1;
    else out.push({ text, count: 1 });
  }
  return out;
}
