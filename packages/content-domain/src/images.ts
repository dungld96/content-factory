import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './execution-key.js';

/**
 * Image generation for storyboard scenes (M4 design §5). Pure: no I/O.
 */

/**
 * `image.v2` adds the product lines (brief product references). Without product references its
 * text equals `image.v1`, so v1 jobs replay unchanged; the worker records each job's own id.
 */
export const IMAGE_PROMPT_TEMPLATE_ID = 'image.v2';
/** Candidates per scene per request (decision G5: default 1, at most 4). */
export const IMAGE_CANDIDATES = { default: 1, max: 4 } as const;
/** Default output tier: a 9:16 2K image is the closest tier to 1080×1920 without upscaling. */
export const DEFAULT_IMAGE_RESOLUTION = '2K' as const;

const qualityTier = z.enum(['economy', 'balanced', 'premium']);

/** The scene fields an image depends on (and nothing else). */
export const imageSceneSchema = z.strictObject({
  sceneNumber: z.number().int().positive(),
  shotType: z.string(),
  cameraAngle: z.string(),
  visualDescription: z.string(),
  imagePrompt: z.string(),
  negativePrompt: z.string(),
  characterVersionId: z.uuid().nullable(),
  environmentVersionId: z.uuid().nullable(),
});
export type ImageScene = z.infer<typeof imageSceneSchema>;

export const referenceRoleSchema = z.enum([
  'character',
  'product',
  'environment',
  'scene_reference',
]);
export type ReferenceRole = z.infer<typeof referenceRoleSchema>;

/** `generation_jobs.input` for image generation: everything the worker needs, fixed at creation. */
export const imageJobInputSchema = z.strictObject({
  storyboardVersionId: z.uuid(),
  sceneId: z.uuid(),
  scene: imageSceneSchema,
  /** Character/environment names for the prompt (from their approved masters). */
  characterName: z.string().nullable(),
  environmentName: z.string().nullable(),
  aspectRatio: z.enum(['9:16', '1:1', '16:9']),
  resolution: z.enum(['1K', '1.5K', '2K']).nullable(),
  count: z.number().int().min(1).max(IMAGE_CANDIDATES.max),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .nullable(),
  /** In sending order: character master, brief products, environment, scene references. */
  references: z.array(z.strictObject({ assetId: z.uuid(), role: referenceRoleSchema })).max(16),
  /** Content hash of the scene (`sceneContentHash`): identical scenes reuse results. */
  sceneHash: z.string().regex(/^[0-9a-f]{64}$/),
  zeroDataRetention: z.boolean(),
  qualityTier,
});
export type ImageJobInput = z.infer<typeof imageJobInputSchema>;

/**
 * Hash of everything an image of this scene depends on, independent of the scene's id or
 * storyboard version: an unchanged scene in a newer storyboard version hashes the same, so its
 * images and keyframe are reused (CLAUDE.md §2.9, M4 design §5.4).
 */
export function sceneContentHash(input: {
  readonly scene: ImageScene;
  readonly aspectRatio: string;
  readonly referenceAssetIds: readonly string[];
}): string {
  // The scene number is excluded: moving an unchanged scene must not invalidate its images.
  const content = { ...input.scene, sceneNumber: undefined };
  return createHash('sha256')
    .update(
      canonicalJson({
        scene: content,
        aspectRatio: input.aspectRatio,
        references: [...input.referenceAssetIds].sort(),
      }),
    )
    .digest('hex');
}

/**
 * `image.v1`: a deterministic prompt built from the scene (no LLM call in M4, design §5.2).
 * Scene text comes from an approved storyboard; it is still passed as plain description, and
 * image models do not follow instructions the way chat models do.
 */
export function buildImagePrompt(input: {
  readonly scene: ImageScene;
  readonly characterName: string | null;
  readonly environmentName: string | null;
  readonly aspectRatio: string;
  readonly hasReferences: boolean;
  /** Brief product references are among the references (`image.v2`). */
  readonly hasProductReferences?: boolean;
}): string {
  const s = input.scene;
  const product = input.hasProductReferences === true;
  const lines = [
    s.imagePrompt.trim(),
    s.visualDescription.trim() ? `Scene: ${s.visualDescription.trim()}` : '',
    `Shot: ${s.shotType}, ${s.cameraAngle} angle. Vertical-video frame, aspect ratio ${input.aspectRatio}.`,
    input.characterName
      ? `Keep the character "${input.characterName}" consistent with the reference image(s).`
      : '',
    input.environmentName
      ? `Setting: "${input.environmentName}", consistent with the reference image(s).`
      : '',
    product
      ? 'The product shown must be exactly the product in the product reference image(s): same model, shape, proportions, colours, materials, layout and printed markings. Where the text and the reference differ, follow the reference.'
      : '',
    input.hasReferences && !input.characterName && !input.environmentName && !product
      ? 'Stay consistent with the reference image(s).'
      : '',
    product
      ? "No added text, captions or watermarks; keep the product's own logo and markings as in the reference."
      : 'No text, captions, logos or watermarks in the image.',
    s.negativePrompt.trim() ? `Avoid: ${s.negativePrompt.trim()}` : '',
  ];
  return lines.filter((l) => l.length > 0).join('\n');
}

/**
 * Why an asset cannot be bound to production as a reference image (P2b L2), or null: it must be
 * an asset of the project, active, a reference or image, and not rejected.
 */
export function referenceAssetProblem(
  asset:
    | {
        readonly assetType: string;
        readonly archivedAt: Date | null;
        readonly approvalStatus: string;
      }
    | null
    | undefined,
): string | null {
  if (!asset) return 'is not an asset of this project';
  if (asset.archivedAt) return 'is archived';
  if (asset.assetType !== 'reference' && asset.assetType !== 'image') {
    return 'is not a reference image or image';
  }
  if (asset.approvalStatus === 'rejected') return 'was rejected';
  return null;
}
