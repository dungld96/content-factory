import { z } from 'zod';

/**
 * FFprobe/FFmpeg location (M5a, CLAUDE.md §8), shared by the API and the worker. The binaries are
 * a system prerequisite (installed in the deploy image and CI); without them media uploads and
 * video/audio generation answer `503 MEDIA_TOOLS_MISSING` instead of the process refusing to start.
 */
export const mediaEnvShape = {
  FFPROBE_PATH: z.string().trim().min(1).default('ffprobe'),
  FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
  /** Per-call timeout of FFprobe/FFmpeg. */
  MEDIA_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
};

export type MediaEnv = z.output<z.ZodObject<typeof mediaEnvShape>>;

/** The `@acf/media` tools settings from a validated environment. */
export function mediaTools(env: MediaEnv): {
  ffprobePath: string;
  ffmpegPath: string;
  timeoutMs: number;
} {
  return {
    ffprobePath: env.FFPROBE_PATH,
    ffmpegPath: env.FFMPEG_PATH,
    timeoutMs: env.MEDIA_TOOL_TIMEOUT_MS,
  };
}
