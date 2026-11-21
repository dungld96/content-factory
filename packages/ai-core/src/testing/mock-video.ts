import type { GenerationContext } from '../capability.js';
import type { ProviderError } from '../errors.js';
import {
  parseTtsRequest,
  parseVideoRequest,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type VideoDownload,
  type VideoJobState,
  type VideoJobStatus,
  type VideoProvider,
  type VideoRequest,
} from '../media.js';
import type { UsdAmount } from '../money.js';
import { ttsCharacters } from '../pricing.js';

/**
 * Deterministic async video provider for tests, local development and E2E (M5 design §3.1). No
 * network. A job becomes terminal after `pollsUntilDone` polls. The clip bytes come from
 * `renderClip` (the worker passes an FFmpeg renderer so the pipeline handles a real MP4); the
 * default returns placeholder bytes for pure unit tests. Every submission is counted, so tests
 * can prove that a restart resumes polling instead of submitting again.
 */
export type MockVideoOutcome =
  | { readonly kind: 'complete'; readonly reportedCost?: UsdAmount | null }
  | { readonly kind: 'fail'; readonly error: string }
  | { readonly kind: 'expire' }
  | { readonly kind: 'cancel' };

/** One scripted step per submission (consumed in order). */
export type MockVideoStep =
  MockVideoOutcome | { readonly kind: 'submit-error'; readonly error: ProviderError };

export interface ClipSpec {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  /** The first frame, when the request had one. */
  readonly firstFrame: VideoRequest['firstFrame'];
}

/** Pixel size of the mock clips per aspect ratio (small: fast to render and store). */
export const MOCK_VIDEO_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  '9:16': [360, 640],
  '1:1': [480, 480],
  '16:9': [640, 360],
};

interface MockJob {
  readonly spec: ClipSpec;
  readonly outcome: MockVideoOutcome;
  polls: number;
}

const PLACEHOLDER = new TextEncoder().encode('MOCK VIDEO (no renderer configured)');

/** Mock job ids carry the clip spec, so a fresh mock (e.g. after a restart) can still answer. */
const ID = /^mock-vid-(\d+)-(\d+)s-(\d+)x(\d+)$/;

export class MockVideoProvider implements VideoProvider {
  readonly providerKey: string;
  readonly capability = 'video_generation' as const;
  private readonly steps: MockVideoStep[];
  private readonly jobs = new Map<string, MockJob>();
  private readonly pollsUntilDone: number;
  private readonly renderClip: (spec: ClipSpec) => Promise<Uint8Array>;
  /** Every accepted submission, in order (the restart test counts them). */
  readonly submissions: VideoRequest[] = [];
  private counter = 0;

  constructor(
    options: {
      providerKey?: string;
      steps?: readonly MockVideoStep[];
      pollsUntilDone?: number;
      renderClip?: (spec: ClipSpec) => Promise<Uint8Array>;
    } = {},
  ) {
    this.providerKey = options.providerKey ?? 'mock';
    this.steps = [...(options.steps ?? [])];
    this.pollsUntilDone = options.pollsUntilDone ?? 2;
    this.renderClip = options.renderClip ?? (() => Promise.resolve(PLACEHOLDER));
  }

  script(...steps: MockVideoStep[]): void {
    this.steps.push(...steps);
  }

  submit(
    input: VideoRequest,
    _context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState> {
    const request = parseVideoRequest(input);
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const step = this.steps.shift();
    if (step?.kind === 'submit-error') return Promise.reject(step.error);
    this.submissions.push(request);
    const [width, height] = MOCK_VIDEO_SIZE[request.aspectRatio] ?? [480, 480];
    const id = `mock-vid-${String(++this.counter)}-${String(request.durationSeconds)}s-${String(width)}x${String(height)}`;
    this.jobs.set(id, {
      spec: {
        durationSeconds: request.durationSeconds,
        width,
        height,
        firstFrame: request.firstFrame,
      },
      outcome: step ?? { kind: 'complete' },
      polls: 0,
    });
    return Promise.resolve(this.view(id, 'pending'));
  }

  poll(
    providerJobId: string,
    _context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const job = this.job(providerJobId);
    job.polls += 1;
    if (job.polls < this.pollsUntilDone)
      return Promise.resolve(this.view(providerJobId, 'running'));
    const status: VideoJobStatus =
      job.outcome.kind === 'complete'
        ? 'completed'
        : job.outcome.kind === 'fail'
          ? 'failed'
          : job.outcome.kind === 'expire'
            ? 'expired'
            : 'cancelled';
    return Promise.resolve(this.view(providerJobId, status));
  }

  async download(
    providerJobId: string,
    index: number,
    _context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoDownload> {
    if (signal.aborted) throw new Error('aborted');
    if (index !== 0) throw new Error(`mock video jobs have one output, not ${String(index + 1)}`);
    const bytes = await this.renderClip(this.job(providerJobId).spec);
    return {
      contentType: 'video/mp4',
      contentLength: bytes.byteLength,
      body: (async function* () {
        await Promise.resolve();
        yield bytes;
      })(),
    };
  }

  private job(id: string): MockJob {
    const known = this.jobs.get(id);
    if (known) return known;
    const match = ID.exec(id);
    if (!match) throw new Error(`unknown mock video job ${id}`);
    // A job submitted by an earlier process: it completed meanwhile.
    const job: MockJob = {
      spec: {
        durationSeconds: Number(match[2]),
        width: Number(match[3]),
        height: Number(match[4]),
        firstFrame: undefined,
      },
      outcome: { kind: 'complete' },
      polls: this.pollsUntilDone,
    };
    this.jobs.set(id, job);
    return job;
  }

  private view(id: string, status: VideoJobStatus): VideoJobState {
    const job = this.job(id);
    const outcome = job.outcome;
    return {
      providerJobId: id,
      status,
      error:
        status === 'failed' && outcome.kind === 'fail'
          ? outcome.error
          : status === 'expired'
            ? 'Job exceeded maximum time to live'
            : status === 'cancelled'
              ? 'Job was cancelled'
              : null,
      reportedCost:
        status === 'completed' && outcome.kind === 'complete'
          ? (outcome.reportedCost ?? null)
          : null,
      outputCount: status === 'completed' ? 1 : 0,
      expiresAt: null,
    };
  }
}

/** One scripted TTS outcome (consumed in order); unscripted calls render audio. */
export type MockTtsStep =
  | { readonly kind: 'result'; readonly reportedCost?: UsdAmount | null }
  | { readonly kind: 'error'; readonly error: ProviderError };

/**
 * Deterministic TTS provider. `renderAudio` turns the text into audio bytes (the worker passes
 * an FFmpeg tone whose length follows the text, ~15 characters per second).
 */
export class MockTtsProvider implements TtsProvider {
  readonly providerKey: string;
  readonly capability = 'tts' as const;
  private readonly steps: MockTtsStep[];
  private readonly renderAudio: (request: TtsRequest) => Promise<Uint8Array>;
  readonly calls: TtsRequest[] = [];

  constructor(
    options: {
      providerKey?: string;
      steps?: readonly MockTtsStep[];
      renderAudio?: (request: TtsRequest) => Promise<Uint8Array>;
    } = {},
  ) {
    this.providerKey = options.providerKey ?? 'mock';
    this.steps = [...(options.steps ?? [])];
    this.renderAudio =
      options.renderAudio ?? (() => Promise.resolve(new TextEncoder().encode('ID3 MOCK AUDIO')));
  }

  script(...steps: MockTtsStep[]): void {
    this.steps.push(...steps);
  }

  async synthesize(
    input: TtsRequest,
    _context: GenerationContext,
    signal: AbortSignal,
  ): Promise<TtsResult> {
    const request = parseTtsRequest(input);
    this.calls.push(request);
    if (signal.aborted) throw new Error('aborted');
    const step = this.steps.shift();
    if (step?.kind === 'error') throw step.error;
    return {
      bytes: await this.renderAudio(request),
      mimeType: 'audio/mpeg',
      characters: ttsCharacters(request.text),
      reportedCost: step?.reportedCost ?? null,
      providerRequestId: `mock-tts-${String(this.calls.length)}`,
      latencyMs: 1,
    };
  }
}
