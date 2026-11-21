import type { CreateRenderRequest } from '@acf/contracts';

/** What the render panel's Audio section holds (P4 design S1). */
export interface AudioState {
  readonly voiceEnabled: boolean;
  readonly voiceGainDb: number;
  readonly clipAudio: boolean;
  readonly clipGainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly ducking: boolean;
  readonly sfx: readonly { assetId: string; sceneId: string; offsetMs: number; gainDb: number }[];
  /** Per scene: voice-over offset and music mute. */
  readonly scenes: Readonly<Record<string, { voiceOffsetMs: number; muteMusic: boolean }>>;
}

export const DEFAULT_AUDIO: AudioState = {
  voiceEnabled: true,
  voiceGainDb: 0,
  clipAudio: false,
  clipGainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 1500,
  ducking: true,
  sfx: [],
  scenes: {},
};

/**
 * The request's `audio` block, or undefined when every setting is at its default: the render is
 * then exactly today's (renderer v1) and an identical earlier render is reused.
 */
export function audioRequest(state: AudioState): CreateRenderRequest['audio'] {
  const scenes = Object.entries(state.scenes)
    .filter(([, v]) => v.voiceOffsetMs > 0 || v.muteMusic)
    .map(([sceneId, v]) => ({ sceneId, voiceOffsetMs: v.voiceOffsetMs, muteMusic: v.muteMusic }));
  const changed =
    !state.voiceEnabled ||
    state.voiceGainDb !== 0 ||
    state.clipAudio ||
    state.fadeInMs !== DEFAULT_AUDIO.fadeInMs ||
    state.fadeOutMs !== DEFAULT_AUDIO.fadeOutMs ||
    !state.ducking ||
    state.sfx.length > 0 ||
    scenes.length > 0;
  if (!changed) return undefined;
  return {
    voice: { enabled: state.voiceEnabled, gainDb: state.voiceGainDb },
    music: { fadeInMs: state.fadeInMs, fadeOutMs: state.fadeOutMs, ducking: state.ducking },
    clipAudio: { enabled: state.clipAudio, gainDb: state.clipGainDb },
    sfx: state.sfx.map((x) => ({ ...x })),
    scenes,
  };
}

/** Blockers that no longer apply when the voice layer is off (the API re-checks). */
export const VOICE_BLOCKERS: ReadonlySet<string> = new Set([
  'VOICEOVERS_INCOMPLETE',
  'VOICEOVER_EXCEEDS_SCENE',
]);
