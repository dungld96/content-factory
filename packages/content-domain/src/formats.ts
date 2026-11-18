/**
 * Content formats: the shape of a deliverable and therefore its pipeline (M3.5 review §2.1,
 * AD-3). Mirrors the database enum `content_format`; a new format is a code change.
 */
export const CONTENT_FORMATS = ['short_video'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** Short-video duration range for generation (M3 design §5.1). */
export const SHORT_VIDEO_SECONDS = { min: 5, max: 180 } as const;

/** Aspect ratios a content item can be created with (contracts `aspectRatioSchema`). */
export const ASPECT_RATIOS = ['9:16', '16:9', '1:1'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface FormatDefinition {
  readonly format: ContentFormat;
  readonly label: string;
  /** Duration range generation accepts, in seconds; `null` for formats without a duration. */
  readonly durationSeconds: { readonly min: number; readonly max: number } | null;
  readonly aspectRatios: readonly AspectRatio[];
  readonly defaultAspectRatio: AspectRatio;
}

/**
 * Format registry. `short_video` reuses the M3 rules unchanged (`SHORT_VIDEO_SECONDS`, every
 * contract aspect ratio). Pipeline stage descriptors arrive with M4+ (review §7, R1).
 */
export const FORMAT_DEFINITIONS: Readonly<Record<ContentFormat, FormatDefinition>> = {
  short_video: {
    format: 'short_video',
    label: 'Short video',
    durationSeconds: SHORT_VIDEO_SECONDS,
    aspectRatios: ASPECT_RATIOS,
    defaultAspectRatio: '9:16',
  },
};

export function formatDefinition(format: ContentFormat): FormatDefinition {
  return FORMAT_DEFINITIONS[format];
}
