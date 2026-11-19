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

/** Gates a stage can require (ADR-0005; computed from approval pointers and keyframes). */
export type GateKey =
  | 'script_approved'
  | 'storyboard_approved'
  | 'keyframes_approved'
  /** M5 gate 4 (design §2): every scene has an approved clip … */
  | 'clips_approved'
  /** … and every scene with voice-over text has an approved voice-over. */
  | 'voiceovers_approved';

/** One pipeline stage of a format (M3.5 review §2.3, R1). */
export interface StageDefinition {
  readonly key: 'script' | 'storyboard' | 'images' | 'clips' | 'voiceover';
  readonly jobKind:
    | 'script_generation'
    | 'storyboard_generation'
    | 'image_generation'
    | 'video_generation'
    | 'tts_generation';
  /** Gates that must hold before the stage may run. */
  readonly requires: readonly GateKey[];
  /** The gate this stage's approval satisfies. */
  readonly produces: GateKey;
  /** `unit` = one job per scene/slide/section (scene-level retry). */
  readonly scope: 'variant' | 'unit';
}

export interface FormatDefinition {
  readonly format: ContentFormat;
  readonly label: string;
  /** Ordered pipeline (M4 implements up to images; video, audio, render follow in M5–M6). */
  readonly stages: readonly StageDefinition[];
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
    stages: [
      {
        key: 'script',
        jobKind: 'script_generation',
        requires: [],
        produces: 'script_approved',
        scope: 'variant',
      },
      {
        key: 'storyboard',
        jobKind: 'storyboard_generation',
        requires: ['script_approved'],
        produces: 'storyboard_approved',
        scope: 'variant',
      },
      {
        key: 'images',
        jobKind: 'image_generation',
        requires: ['storyboard_approved'],
        produces: 'keyframes_approved',
        scope: 'unit',
      },
      // M5: a scene's clip needs that scene's keyframe (checked per scene by the API); the
      // voice-over needs only the approved storyboard, so it can run alongside images.
      {
        key: 'clips',
        jobKind: 'video_generation',
        requires: ['storyboard_approved'],
        produces: 'clips_approved',
        scope: 'unit',
      },
      {
        key: 'voiceover',
        jobKind: 'tts_generation',
        requires: ['storyboard_approved'],
        produces: 'voiceovers_approved',
        scope: 'unit',
      },
    ],
    durationSeconds: SHORT_VIDEO_SECONDS,
    aspectRatios: ASPECT_RATIOS,
    defaultAspectRatio: '9:16',
  },
};

export function formatDefinition(format: ContentFormat): FormatDefinition {
  return FORMAT_DEFINITIONS[format];
}

/** Gates a stage still needs (empty = it may run). Unknown stage → throws (a code error). */
export function missingGates(
  format: ContentFormat,
  stage: StageDefinition['key'],
  satisfied: ReadonlySet<GateKey>,
): GateKey[] {
  const definition = FORMAT_DEFINITIONS[format].stages.find((s) => s.key === stage);
  if (!definition) throw new Error(`format ${format} has no stage ${stage}`);
  return definition.requires.filter((gate) => !satisfied.has(gate));
}
