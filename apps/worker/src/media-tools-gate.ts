import { checkMediaTools, type MediaTools, type MediaToolsStatus } from '@acf/media';

/** How long a successful check is trusted before the tools are checked again (P3d R6). */
export const MEDIA_TOOLS_RECHECK_MS = 5 * 60_000;

export type MediaToolsCheck = (tools: MediaTools) => Promise<MediaToolsStatus>;

/**
 * Checks FFmpeg/FFprobe before a paid media call (P3d design R6), so a missing install never
 * costs money. A good result is reused for five minutes; a missing tool is checked again on every
 * call, so installing FFmpeg needs no worker restart.
 */
export class MediaToolsGate {
  private last: { readonly status: MediaToolsStatus; readonly at: number } | null = null;

  constructor(
    private readonly tools: MediaTools,
    private readonly check: MediaToolsCheck = checkMediaTools,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current status (cached while it is good and recent). */
  async status(): Promise<MediaToolsStatus> {
    const last = this.last;
    if (last && isComplete(last.status) && this.now() - last.at < MEDIA_TOOLS_RECHECK_MS) {
      return last.status;
    }
    const status = await this.check(this.tools);
    this.last = { status, at: this.now() };
    return status;
  }

  /** Null when both tools run; otherwise the names of the missing tools, for the job error. */
  async missing(): Promise<string | null> {
    const status = await this.status();
    const names = [
      ...(status.ffmpeg === null ? ['FFmpeg'] : []),
      ...(status.ffprobe === null ? ['FFprobe'] : []),
    ];
    return names.length === 0 ? null : names.join(' and ');
  }
}

const isComplete = (s: MediaToolsStatus): boolean => s.ffmpeg !== null && s.ffprobe !== null;
