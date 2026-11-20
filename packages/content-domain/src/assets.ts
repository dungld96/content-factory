// Asset metadata keys the platform writes and later relies on (P2a design A2). Browser-safe:
// exported through `@acf/content-domain/schemas`. The same list is frozen by the database trigger
// `acf_asset_guard` (migration p2_asset_metadata_guard); a database test keeps them equal.

export const SYSTEM_METADATA_KEYS = [
  // Upload purpose: decides voice-over candidates and music eligibility.
  'purpose',
  // Reuse of paid results (images, clips, voice-overs).
  'sceneHash',
  'clipHash',
  'voiceoverHash',
  // Provenance and probe data.
  'model',
  'audio',
  'video',
  'requestedSeconds',
  'resolution',
  'voice',
  'language',
  'characters',
  'exceedsScene',
  // Render outputs.
  'renderId',
  'upscaledFrom',
  'cues',
  'thumbnail',
] as const;

export type SystemMetadataKey = (typeof SYSTEM_METADATA_KEYS)[number];

const RESERVED: ReadonlySet<string> = new Set(SYSTEM_METADATA_KEYS);

/** The reserved keys a caller tried to set (registration or edit); empty when none. */
export function reservedMetadataKeys(requested: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(requested).filter((k) => RESERVED.has(k));
}

/**
 * The metadata stored after an edit: the caller's keys replace the editable ones, and the
 * reserved keys keep their stored values (an edit never removes them). Call only after
 * {@link reservedMetadataKeys} returned none.
 */
export function mergeEditedMetadata(
  stored: unknown,
  requested: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      if (RESERVED.has(k)) kept[k] = v;
    }
  }
  return { ...requested, ...kept };
}
