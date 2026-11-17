import type { Capability } from './capability.js';

/**
 * Media capability interfaces, declared so the capability model is complete (ADR-0004). Their
 * request/result types and methods are designed with their first adapters: image in M4,
 * video and TTS in M5. There is deliberately no universal `generate()`.
 */
interface MediaProviderBase<C extends Capability> {
  readonly providerKey: string;
  readonly capability: C;
}

/** M4. */
export type ImageProvider = MediaProviderBase<'image_generation'>;
/** M4. */
export type ImageEditProvider = MediaProviderBase<'image_edit'>;
/** M5. */
export type VideoProvider = MediaProviderBase<'video_generation'>;
/** M5. */
export type TtsProvider = MediaProviderBase<'tts'>;
