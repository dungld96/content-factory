import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './execution-key.js';

/**
 * Renders (M6 design §3–§5): what a render assembles (the manifest, frozen at creation), how
 * (the settings) and the job contract between the API and the worker. Pure: no I/O.
 */

/** Render jobs: CPU-bound FFmpeg work on its own queue (concurrency 1 by default). */
export const RENDER_QUEUE = 'generation-render';
/** Above the per-render FFmpeg ceiling (default 10 min, `RENDER_TIMEOUT_MS`). */
export const RENDER_JOB_LOCK_MS = 900_000;
/** Bumped when the pipeline changes what identical inputs produce (part of the reuse key). */
export const RENDERER_VERSION = 'render.v1';
/** Music bed level under the voice by default (X5). */
export const DEFAULT_MUSIC_VOLUME_DB = -18;

const uuid = z.uuid();

export const renderManifestSceneSchema = z.strictObject({
  sceneId: uuid,
  sceneNumber: z.number().int().positive(),
  /** Scene length in the render (the storyboard duration). */
  durationMs: z.number().int().positive(),
  clipAssetId: uuid,
  clipDurationMs: z.number().int().positive(),
  /** Clip size, to report upscaling (a 720×1280 clip is "720p"). */
  clipWidth: z.number().int().positive().nullable(),
  clipHeight: z.number().int().positive().nullable(),
  keyframeAssetId: uuid.nullable(),
  voiceoverAssetId: uuid.nullable(),
  voiceoverDurationMs: z.number().int().positive().nullable(),
  /** Narration text for captions ('' when the scene has none). */
  text: z.string().max(5000),
  /** Source models of the clip and voice-over (traceability in the package). */
  clipModel: z.string().nullable(),
  voiceoverModel: z.string().nullable(),
});
export type RenderManifestScene = z.infer<typeof renderManifestSceneSchema>;

export const renderManifestSchema = z.strictObject({
  storyboardVersionId: uuid,
  scenes: z.array(renderManifestSceneSchema).min(1).max(100),
  music: z
    .strictObject({
      assetId: uuid,
      volumeDb: z.number().min(-40).max(0),
      licenseNote: z.string().nullable(),
    })
    .nullable(),
});
export type RenderManifest = z.infer<typeof renderManifestSchema>;

export const renderSettingsSchema = z.strictObject({
  renderer: z.literal(RENDERER_VERSION),
  output: z.strictObject({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(30),
    videoCodec: z.literal('h264'),
    crf: z.number().int(),
    audioCodec: z.literal('aac'),
    audioBitrate: z.string(),
    sampleRate: z.number().int(),
  }),
  loudness: z.strictObject({
    integrated: z.number(),
    truePeak: z.number(),
    range: z.number(),
  }),
  captions: z.strictObject({
    burnIn: z.boolean(),
    font: z.string(),
    maxLines: z.number().int(),
    maxChars: z.number().int(),
  }),
});
export type RenderSettings = z.infer<typeof renderSettingsSchema>;

/** The settings of a render (X3, X4, X8, X12). */
export function renderSettings(burnInCaptions: boolean): RenderSettings {
  return {
    renderer: RENDERER_VERSION,
    output: {
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      crf: 20,
      audioCodec: 'aac',
      audioBitrate: '192k',
      sampleRate: 48_000,
    },
    loudness: { integrated: -14, truePeak: -1, range: 11 },
    captions: {
      burnIn: burnInCaptions,
      font: 'Be Vietnam Pro SemiBold',
      maxLines: 2,
      maxChars: 32,
    },
  };
}

/** Identical manifest + settings (incl. renderer version) → identical render: reuse it. */
export function renderExecutionKey(manifest: RenderManifest, settings: RenderSettings): string {
  return createHash('sha256').update(canonicalJson({ manifest, settings })).digest('hex');
}

/** `generation_jobs.input` of a render job: the render row holds everything else. */
export const renderJobInputSchema = z.strictObject({ renderId: uuid });
export type RenderJobInput = z.infer<typeof renderJobInputSchema>;

export const activeRenderJobKey = (contentItemId: string) => `${contentItemId}:render`;

/**
 * "720p" (the short side of the smallest clip) when a clip is smaller than the 1080×1920 output
 * and is therefore scaled up (X3: labelled, never described as better); null when none is.
 */
export function upscaledFrom(manifest: RenderManifest, outputShortSide = 1080): string | null {
  const sides = manifest.scenes
    .map((s) =>
      s.clipWidth === null || s.clipHeight === null ? null : Math.min(s.clipWidth, s.clipHeight),
    )
    .filter((side): side is number => side !== null && side < outputShortSide);
  return sides.length === 0 ? null : `${String(Math.min(...sides))}p`;
}
