import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import {
  parseVideoRequest,
  type VideoDownload,
  type VideoJobState,
  type VideoJobStatus,
  type VideoProvider,
  type VideoRequest,
} from '../media.js';
import { MoneyError, UsdAmount } from '../money.js';
import { OPENROUTER_PROVIDER_KEY, type OpenRouterConfig } from './config.js';
import { rejection } from './http.js';

/**
 * OpenRouter Video API adapter (M5 design §3.2; verification record
 * `docs/design/m5/openrouter-video-tts-verification.md` §1). Asynchronous: `POST /videos` returns a
 * job, `GET /videos/{id}` reports its state, `GET /videos/{id}/content` streams the output.
 * Submitting is paid and has no idempotency key: a submit whose response was lost is reported
 * with outcome `unknown`, never `not_sent`, so the caller does not resubmit blindly (decision V3).
 * The signed `urls` of a completed job are secrets and are never read or logged.
 */

export const openRouterVideoJobSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  polling_url: z.string().optional(),
  error: z.string().nullable().optional(),
  expires_at: z.number().nullable().optional(),
  generation_id: z.string().nullable().optional(),
  unsigned_urls: z.array(z.string()).nullable().optional(),
  usage: z
    .object({ cost: z.number().nullable().optional(), is_byok: z.boolean().optional() })
    .nullable()
    .optional(),
});
export type OpenRouterVideoJob = z.infer<typeof openRouterVideoJobSchema>;

/** Routing preferences for video calls: never train on our data. ZDR does not exist for video. */
export const OPENROUTER_VIDEO_PROVIDER_PREFERENCES = { data_collection: 'deny' } as const;

const STATUS: Readonly<Record<string, VideoJobStatus>> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
};

/** Builds the `POST /videos` body. Exported for contract tests. */
export function buildVideoBody(request: VideoRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelKey,
    prompt: request.prompt,
    duration: request.durationSeconds,
    resolution: request.resolution,
    aspect_ratio: request.aspectRatio,
    // Always explicit: some providers generate audio by default (verification record §1).
    generate_audio: request.generateAudio,
    provider: { ...OPENROUTER_VIDEO_PROVIDER_PREFERENCES },
  };
  if (request.seed !== undefined) body['seed'] = request.seed;
  if (request.firstFrame) {
    const { mimeType, bytes } = request.firstFrame;
    body['frame_images'] = [
      {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` },
        frame_type: 'first_frame',
      },
    ];
  }
  return body;
}

/** Errors raised by fetch before any byte left this machine. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);
function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

const JOB_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export class OpenRouterVideoProvider implements VideoProvider {
  readonly providerKey = OPENROUTER_PROVIDER_KEY;
  readonly capability = 'video_generation' as const;
  private readonly base: string;

  constructor(private readonly config: OpenRouterConfig) {
    this.base = config.baseUrl.replace(/\/+$/, '');
  }

  async submit(
    input: VideoRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState> {
    const request = parseVideoRequest(input);
    const combined = this.signal(context, signal);
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${this.base}/videos`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildVideoBody(request)),
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      const notSent = NOT_SENT_CODES.has(causeCode(error) ?? '');
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        combined.aborted
          ? 'video submit timed out or was aborted'
          : 'network error calling OpenRouter',
        {
          // The job may have been accepted (and will be charged): never resubmit blindly.
          outcome: notSent ? ProviderErrorOutcome.NOT_SENT : ProviderErrorOutcome.UNKNOWN,
          cause: error,
        },
      );
    }
    if (!response.ok) throw rejection(response, raw);
    return this.state(raw, 'submit');
  }

  async poll(
    providerJobId: string,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState> {
    const id = checkId(providerJobId);
    const combined = this.signal(context, signal);
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${this.base}/videos/${encodeURIComponent(id)}`, {
        headers: this.headers({ Accept: 'application/json' }),
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      // A status read costs nothing: the caller may simply poll again.
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        'could not read the video job status',
        { outcome: ProviderErrorOutcome.NOT_SENT, cause: error },
      );
    }
    if (!response.ok) throw rejection(response, raw);
    return this.state(raw, 'poll');
  }

  async download(
    providerJobId: string,
    index: number,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoDownload> {
    const id = checkId(providerJobId);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'invalid output index', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const combined = this.signal(context, signal);
    let response: Response;
    try {
      response = await fetch(
        `${this.base}/videos/${encodeURIComponent(id)}/content?index=${String(index)}`,
        { headers: this.headers({}), signal: combined, redirect: 'follow' },
      );
    } catch (error) {
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        'could not download the video',
        { outcome: ProviderErrorOutcome.NOT_SENT, cause: error },
      );
    }
    if (!response.ok || !response.body) {
      throw rejection(response, await response.text().catch(() => ''));
    }
    const length = Number(response.headers.get('content-length'));
    return {
      contentType: response.headers.get('content-type'),
      contentLength: Number.isSafeInteger(length) && length > 0 ? length : null,
      body: response.body,
    };
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...extra,
      ...(this.config.attribution
        ? {
            'HTTP-Referer': this.config.attribution.url,
            'X-OpenRouter-Title': this.config.attribution.title,
          }
        : {}),
    };
  }

  private signal(context: GenerationContext, signal: AbortSignal): AbortSignal {
    const remaining =
      context.deadlineAt === undefined ? Infinity : context.deadlineAt.getTime() - Date.now();
    if (signal.aborted || remaining <= 0) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'deadline passed before sending', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.config.timeoutMs, remaining)));
    return AbortSignal.any([signal, timeout]);
  }

  private state(raw: string, phase: 'submit' | 'poll'): VideoJobState {
    let job: OpenRouterVideoJob;
    try {
      const parsed = openRouterVideoJobSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw parsed.error;
      job = parsed.data;
    } catch (cause) {
      throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'unparseable video job', {
        // After a submit the job may exist: its id is unknown, so the outcome is unknown.
        outcome: phase === 'submit' ? ProviderErrorOutcome.UNKNOWN : ProviderErrorOutcome.NOT_SENT,
        cause,
      });
    }
    const status = STATUS[job.status];
    if (!status) {
      throw new ProviderError(
        ProviderErrorCode.MALFORMED_RESPONSE,
        `unknown video job status ${job.status.slice(0, 32)}`,
        { outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE, providerRequestId: job.id },
      );
    }
    let reportedCost: UsdAmount | null;
    try {
      const cost = job.usage?.cost;
      reportedCost = cost === null || cost === undefined ? null : UsdAmount.parse(cost);
    } catch (cause) {
      if (!(cause instanceof MoneyError)) throw cause;
      throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'invalid usage.cost', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        providerRequestId: job.id,
        cause,
      });
    }
    return {
      providerJobId: job.id,
      status,
      error: job.error ? job.error.slice(0, 500) : null,
      reportedCost,
      outputCount: status === 'completed' ? Math.max(1, job.unsigned_urls?.length ?? 1) : 0,
      expiresAt:
        typeof job.expires_at === 'number' && Number.isFinite(job.expires_at)
          ? new Date(job.expires_at * 1000)
          : null,
    };
  }
}

function checkId(providerJobId: string): string {
  if (!JOB_ID.test(providerJobId)) {
    throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'invalid provider job id', {
      outcome: ProviderErrorOutcome.NOT_SENT,
    });
  }
  return providerJobId;
}
