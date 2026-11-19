import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './execution-key.js';

/**
 * Video clips and voice-overs for storyboard scenes (M5 design §5–§7). Pure: no I/O.
 */

export const VIDEO_PROMPT_TEMPLATE_ID = 'video.v1';
export const TTS_TEMPLATE_ID = 'tts.v1';
/** Video jobs: submit and each poll are BullMQ jobs on this queue (M5 design §5.1). */
export const VIDEO_GENERATION_QUEUE = 'generation-video';
/** TTS jobs (synchronous calls) have their own queue and concurrency. */
export const AUDIO_GENERATION_QUEUE = 'generation-audio';
/** A submit, a poll or a download step must finish within this lock (download ≤ 200 MB). */
export const VIDEO_JOB_LOCK_MS = 300_000;
/** Above the TTS provider timeout (120 s). */
export const AUDIO_JOB_LOCK_MS = 180_000;
/** Largest clip the worker downloads (M5 design §10 R10). */
export const MAX_CLIP_BYTES = 200 * 1024 * 1024;
/**
 * Last-resort bound on following one provider job. The provider bounds its own jobs (OpenRouter
 * reports `expired`), so this only catches a provider that never answers terminally.
 */
export const VIDEO_POLL_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Default clip resolution (decision V4); 1080p on request. */
export const DEFAULT_VIDEO_RESOLUTION = '720p' as const;

/**
 * Delay before poll number `pollCount + 1` (decision V3): 15 s, 30 s, 60 s, then +60 s per
 * poll up to 5 minutes. Status reads are free, but long-running jobs need not be hammered.
 */
export function videoPollDelayMs(pollCount: number): number {
  if (pollCount <= 0) return 15_000;
  if (pollCount === 1) return 30_000;
  return Math.min(300_000, 60_000 * (pollCount - 1));
}

const qualityTier = z.enum(['economy', 'balanced', 'premium']);

/** The scene fields a clip depends on (and nothing else). */
export const videoSceneSchema = z.strictObject({
  sceneNumber: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  videoPrompt: z.string(),
  cameraMovement: z.string(),
  characterAction: z.string(),
  visualDescription: z.string(),
});
export type VideoScene = z.infer<typeof videoSceneSchema>;

/** `generation_jobs.input` for video generation: everything the worker needs, fixed at creation. */
export const videoJobInputSchema = z.strictObject({
  storyboardVersionId: z.uuid(),
  sceneId: z.uuid(),
  scene: videoSceneSchema,
  /** The approved keyframe sent as the first frame (gate 3 for this scene). */
  keyframeAssetId: z.uuid(),
  /** Billed clip length: one of the model's supported durations (decision V5). */
  durationSeconds: z.number().int().positive(),
  resolution: z.enum(['480p', '720p', '1080p']),
  aspectRatio: z.enum(['9:16', '1:1', '16:9']),
  generateAudio: z.boolean(),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .nullable(),
  /** `clipContentHash`: identical scene + keyframe + settings reuse an earlier clip. */
  clipHash: z.string().regex(/^[0-9a-f]{64}$/),
  qualityTier,
});
export type VideoJobInput = z.infer<typeof videoJobInputSchema>;

/** Everything a clip depends on, independent of scene id and storyboard version. */
export function clipContentHash(input: {
  readonly scene: VideoScene;
  readonly keyframeAssetId: string;
  readonly modelId: string;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly generateAudio: boolean;
}): string {
  const content = { ...input.scene, sceneNumber: undefined };
  return createHash('sha256')
    .update(canonicalJson({ ...input, scene: content }))
    .digest('hex');
}

/**
 * `video.v1`: a deterministic prompt from the scene (no LLM call). The keyframe carries the look;
 * the prompt describes motion and asks to keep the first frame's subject and composition.
 */
export function buildVideoPrompt(input: {
  readonly scene: VideoScene;
  readonly aspectRatio: string;
}): string {
  const s = input.scene;
  const lines = [
    s.videoPrompt.trim(),
    s.characterAction.trim() ? `Action: ${s.characterAction.trim()}` : '',
    s.cameraMovement.trim() ? `Camera: ${s.cameraMovement.trim()}.` : '',
    s.visualDescription.trim() ? `Scene: ${s.visualDescription.trim()}` : '',
    `Start exactly from the first frame and keep its subject, identity and composition. Vertical video, aspect ratio ${input.aspectRatio}.`,
    'No text, captions, logos or watermarks.',
  ];
  return lines.filter((l) => l.length > 0).join('\n');
}

/** Voice parameters a job snapshots from the voice profile (decision V7). */
export const voiceSnapshotSchema = z.strictObject({
  voiceProfileId: z.uuid(),
  voice: z.string().min(1).max(200),
  language: z.string().min(2).max(35),
  speed: z.number().min(0.5).max(2).nullable(),
  instructions: z.string().max(500).nullable(),
});
export type VoiceSnapshot = z.infer<typeof voiceSnapshotSchema>;

/** `generation_jobs.input` for a scene voice-over. */
export const ttsJobInputSchema = z.strictObject({
  storyboardVersionId: z.uuid(),
  sceneId: z.uuid(),
  sceneNumber: z.number().int().positive(),
  /** The scene's voice-over text (approved storyboard). */
  text: z.string().trim().min(1).max(5000),
  /** Scene length, to flag narration that does not fit (`voiceover_exceeds_scene`). */
  sceneDurationSeconds: z.number().positive(),
  voice: voiceSnapshotSchema,
  /** `voiceoverContentHash`: identical text + voice reuse an earlier voice-over. */
  voiceoverHash: z.string().regex(/^[0-9a-f]{64}$/),
  qualityTier,
});
export type TtsJobInput = z.infer<typeof ttsJobInputSchema>;

export function voiceoverContentHash(input: {
  readonly text: string;
  readonly modelId: string;
  readonly voice: Omit<VoiceSnapshot, 'voiceProfileId'>;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/** Active-job keys of scene-scoped media jobs (one active job per scene and kind). */
export const activeSceneJobKey = (
  sceneId: string,
  kind: 'image_generation' | 'video_generation' | 'tts_generation',
) => `${sceneId}:${kind}`;
