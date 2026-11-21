// Paid, capped smoke runs for video and TTS models (M5 design §3.3, §4.2, §13; decision V12).
// Refused unless ACF_PAID_SMOKE=1, the worst case fits --max-cost-usd, and the estimate is known.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  activePrices,
  assessTtsCost,
  chooseVideoDuration,
  estimateVideoCost,
  TERMINAL_VIDEO_STATUSES,
  ttsCharacters,
  UsdAmount,
  VIDEO_RESOLUTIONS,
  type GenerationContext,
  type VideoJobState,
  type VideoRequest,
  type VideoResolution,
} from '@acf/ai-core';
import {
  createTtsProviders,
  createVideoProviders,
  MediaConstraintError,
  ModelCatalog,
  RoutingError,
  TtsService,
  VideoService,
} from '@acf/ai-runtime';
import { loadApiEnv, mediaTools } from '@acf/config';
import type { PrismaClient } from '@acf/database';
import { inspectAudio, inspectVideoFile } from '@acf/media';
import { inspectImage } from '@acf/storage';

import type { CliIo } from './ai-registry-cli.js';

/** Fixed prompts: known size, so the worst case is bounded before anything is sent. */
export const SMOKE_VIDEO_PROMPT =
  'Slow, steady push-in on a tidy wooden desk with a laptop and a coffee cup, soft morning light, no text.';
export const SMOKE_TTS_TEXT =
  'Năm món đồ nhỏ giúp bàn làm việc của bạn gọn gàng hơn. Five small things that make your desk tidier.';
/** Registry prices are the catalog's default endpoint; the serving endpoint may be dearer. */
export const SMOKE_MEDIA_SAFETY_FACTOR = 2;
const POLL_SCHEDULE_MS = [15_000, 30_000, 60_000];
const POLL_LIMIT_MS = 20 * 60_000;

interface SmokeValues {
  readonly provider: string;
  readonly project?: string | undefined;
  readonly 'max-cost-usd'?: string | undefined;
  readonly count?: string | undefined;
  readonly resolution?: string | undefined;
  readonly out?: string | undefined;
  readonly duration?: string | undefined;
  readonly frame?: string | undefined;
  readonly voice?: string | undefined;
  readonly text?: string | undefined;
}

async function common(
  name: string,
  modelKey: string | undefined,
  values: SmokeValues,
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  extraUsage: string,
): Promise<
  | { ok: true; modelKey: string; cap: UsdAmount; count: number; projectId: string }
  | { ok: false; code: number }
> {
  if (rawEnv['ACF_PAID_SMOKE'] !== '1') {
    io.err(`✖ refused: ${name} makes real, paid calls. Set ACF_PAID_SMOKE=1 to enable it.`);
    return { ok: false, code: 2 };
  }
  if (!modelKey || !values.project || !values['max-cost-usd']) {
    io.err(`${name} <modelKey> --project <slug> --max-cost-usd <usd> ${extraUsage}`);
    return { ok: false, code: 2 };
  }
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    io.err('--count must be an integer from 1 to 10');
    return { ok: false, code: 2 };
  }
  let cap: UsdAmount;
  try {
    cap = UsdAmount.parse(values['max-cost-usd']);
  } catch {
    io.err('--max-cost-usd must be a non-negative decimal');
    return { ok: false, code: 2 };
  }
  const project = await prisma.project.findUnique({
    where: { slug: values.project },
    select: { id: true },
  });
  if (!project) {
    io.err(`✖ unknown project ${values.project}`);
    return { ok: false, code: 1 };
  }
  return { ok: true, modelKey, cap, count, projectId: project.id };
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function smokeVideo(
  modelKey: string | undefined,
  values: SmokeValues,
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const base = await common(
    'smoke-video',
    modelKey,
    values,
    prisma,
    rawEnv,
    io,
    '[--frame img] [--duration s] [--resolution 720p] [--count n] [--out dir]',
  );
  if (!base.ok) return base.code;
  const resolution = (values.resolution ?? '720p') as VideoResolution;
  if (!(VIDEO_RESOLUTIONS as readonly string[]).includes(resolution)) {
    io.err(`--resolution must be one of ${VIDEO_RESOLUTIONS.join(', ')}`);
    return 2;
  }
  const env = loadApiEnv(rawEnv);
  const providers = createVideoProviders(env);
  if (!providers.has(values.provider)) {
    io.err(`✖ refused: provider ${values.provider} has no credentials (OPENROUTER_API_KEY).`);
    return 2;
  }
  let firstFrame: VideoRequest['firstFrame'];
  if (values.frame) {
    const bytes = new Uint8Array(await readFile(values.frame));
    const image = inspectImage(bytes);
    firstFrame = { mimeType: image.mimeType, bytes };
  }
  const catalog = new ModelCatalog(prisma, new Map(), new Map(), providers);
  const videos = new VideoService(prisma, catalog, providers);
  const options = { providerKey: values.provider, allowDisabled: true };
  let request: VideoRequest;
  let worst: UsdAmount | null;
  try {
    // The model's supported durations decide the billed clip length (decision V5).
    const candidate = (await catalog.candidates('video_generation', base.modelKey)).find(
      (r) => r.candidate.providerKey === values.provider,
    );
    const supported = candidate?.videoConstraints?.durations ?? [];
    const wanted = values.duration === undefined ? 4 : Number(values.duration);
    const duration = chooseVideoDuration(wanted, supported) ?? supported[0] ?? wanted;
    request = {
      modelKey: base.modelKey,
      prompt: SMOKE_VIDEO_PROMPT,
      durationSeconds: duration,
      resolution,
      aspectRatio: '9:16',
      generateAudio: false,
      ...(firstFrame ? { firstFrame } : {}),
    };
    const { row } = await videos.route({ qualityTier: 'economy' }, request, options);
    const one = estimateVideoCost({
      prices: activePrices(row.prices, new Date()),
      usage: { seconds: duration, inputImages: firstFrame ? 1 : 0, resolution, audio: false },
    });
    worst = one === null ? null : one.times(base.count).times(SMOKE_MEDIA_SAFETY_FACTOR);
  } catch (error) {
    if (error instanceof RoutingError || error instanceof MediaConstraintError) {
      io.err(`✖ ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (worst === null) {
    io.err(
      '✖ refused: the per-second price is unknown (token-priced?), so the cost cannot be capped.',
    );
    return 2;
  }
  if (worst.compare(base.cap) > 0) {
    io.err(
      `✖ refused: worst case ${worst.toString()} USD exceeds --max-cost-usd ${base.cap.toString()}.`,
    );
    return 2;
  }
  const outDir = path.resolve(values.out ?? 'smoke-videos');
  await mkdir(outDir, { recursive: true });
  io.out(
    `→ ${String(base.count)} paid video job(s) to ${values.provider}/${base.modelKey}: ${String(request.durationSeconds)} s ${resolution} 9:16${firstFrame ? ' from the first frame' : ''} (worst case ${worst.toString()} USD)`,
  );
  let failures = 0;
  for (let i = 1; i <= base.count; i++) {
    const context: GenerationContext = {
      projectId: base.projectId,
      correlationId: `smoke-video-${String(Date.now())}-${String(i)}`,
      qualityTier: 'economy',
    };
    const started = Date.now();
    let invocationId: string | undefined;
    try {
      const submitted = await videos.submit(context, request, options);
      invocationId = submitted.invocationId;
      io.out(`  ${String(i)}: submitted ${submitted.state.providerJobId}`);
      let state: VideoJobState = submitted.state;
      // ACF_SMOKE_POLL_MS: test-only override of the poll schedule.
      const fixedPollMs = Number(rawEnv['ACF_SMOKE_POLL_MS']);
      for (let n = 0; !TERMINAL_VIDEO_STATUSES.has(state.status); n++) {
        if (Date.now() - started > POLL_LIMIT_MS) {
          await videos.abandon(invocationId, 'PROVIDER_TIMEOUT', 'smoke stopped polling');
          throw new Error(
            `still ${state.status} after ${String(POLL_LIMIT_MS / 60_000)} min; job ${state.providerJobId}`,
          );
        }
        await sleep(
          fixedPollMs > 0
            ? fixedPollMs
            : (POLL_SCHEDULE_MS[Math.min(n, POLL_SCHEDULE_MS.length - 1)] ?? 60_000),
        );
        state = await videos.poll(submitted.providerKey, state.providerJobId, context);
        io.out(
          `  ${String(i)}: ${state.status} (${String(Math.round((Date.now() - started) / 1000))} s)`,
        );
      }
      if (state.status !== 'completed') {
        await videos.fail(
          invocationId,
          state,
          `PROVIDER_${state.status.toUpperCase()}`,
          state.error ?? state.status,
        );
        throw new Error(`${state.status}: ${state.error ?? 'no detail'}`);
      }
      const file = path.join(
        outDir,
        `${base.modelKey.replace(/[^a-z0-9._-]+/gi, '_')}-${String(i)}.mp4`,
      );
      const download = await videos.download(
        submitted.providerKey,
        state.providerJobId,
        0,
        context,
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of download.body) chunks.push(chunk);
      await writeFile(file, chunks);
      const clip = await inspectVideoFile(
        file,
        download.contentType,
        { aspectRatio: 9 / 16 },
        mediaTools(env),
      );
      const cost = await videos.complete(invocationId, request, state);
      io.out(
        `✔ ${String(i)}: ${String(clip.width)}×${String(clip.height)} ${clip.codec}, ${String(clip.durationMs)} ms, audio ${clip.hasAudio ? 'yes' : 'no'}, ${String(Math.round((Date.now() - started) / 1000))} s → ${file}`,
      );
      io.out(
        `  cost: reported ${cost.reportedCost?.toString() ?? 'n/a'}, estimated ${cost.estimatedCost?.toString() ?? 'unknown'} (${cost.status}); invocation ${invocationId}`,
      );
    } catch (error) {
      failures += 1;
      io.err(`✖ ${String(i)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

export async function smokeTts(
  modelKey: string | undefined,
  values: SmokeValues,
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const base = await common(
    'smoke-tts',
    modelKey,
    values,
    prisma,
    rawEnv,
    io,
    '--voice <id> [--text "…"] [--count n] [--out dir]',
  );
  if (!base.ok) return base.code;
  if (!values.voice) {
    io.err('--voice is required (see the model voices in `model import-openrouter-tts`)');
    return 2;
  }
  const env = loadApiEnv(rawEnv);
  const constraintsOf = new Map<string, boolean>();
  const providers = createTtsProviders(env, (key) => constraintsOf.get(key) === false);
  if (!providers.has(values.provider)) {
    io.err(`✖ refused: provider ${values.provider} has no credentials (OPENROUTER_API_KEY).`);
    return 2;
  }
  const tts = new TtsService(
    prisma,
    new ModelCatalog(prisma, new Map(), new Map(), new Map(), providers),
    providers,
  );
  const text = values.text ?? SMOKE_TTS_TEXT;
  const request = {
    modelKey: base.modelKey,
    text,
    voice: values.voice,
    dataPolicy: { zeroDataRetention: true },
  };
  const options = { providerKey: values.provider, allowDisabled: true };
  let worst: UsdAmount | null;
  try {
    const { row } = await tts.route({ qualityTier: 'economy' }, request, options);
    constraintsOf.set(base.modelKey, row.ttsConstraints?.mp3 ?? true);
    const one = assessTtsCost({
      characters: ttsCharacters(text),
      prices: activePrices(row.prices, new Date()),
      reportedCost: null,
    }).estimatedCost;
    worst = one === null ? null : one.times(base.count).times(SMOKE_MEDIA_SAFETY_FACTOR);
  } catch (error) {
    if (error instanceof RoutingError || error instanceof MediaConstraintError) {
      io.err(`✖ ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (worst === null) {
    io.err(
      '✖ refused: the per-character price is unknown (token-priced?), so the cost cannot be capped.',
    );
    return 2;
  }
  if (worst.compare(base.cap) > 0) {
    io.err(
      `✖ refused: worst case ${worst.toString()} USD exceeds --max-cost-usd ${base.cap.toString()}.`,
    );
    return 2;
  }
  const outDir = path.resolve(values.out ?? 'smoke-tts');
  await mkdir(outDir, { recursive: true });
  io.out(
    `→ ${String(base.count)} paid TTS call(s) to ${values.provider}/${base.modelKey} voice ${values.voice} (worst case ${worst.toString()} USD)`,
  );
  let failures = 0;
  for (let i = 1; i <= base.count; i++) {
    try {
      const { result, cost, invocationId } = await tts.synthesize(
        {
          projectId: base.projectId,
          correlationId: `smoke-tts-${String(Date.now())}-${String(i)}`,
          qualityTier: 'economy',
        },
        request,
        options,
      );
      const audio = await inspectAudio(result.bytes, result.mimeType, { tools: mediaTools(env) });
      const file = path.join(
        outDir,
        `${base.modelKey.replace(/[^a-z0-9._-]+/gi, '_')}-${values.voice.replace(/[^a-z0-9._-]+/gi, '_')}-${String(i)}.${result.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`,
      );
      await writeFile(file, result.bytes);
      io.out(
        `✔ ${String(i)}: ${String(audio.durationMs)} ms ${audio.codec ?? ''}, ${String(result.latencyMs)} ms → ${file}`,
      );
      io.out(
        `  cost: reported ${cost.reportedCost?.toString() ?? 'n/a'}, estimated ${cost.estimatedCost?.toString() ?? 'unknown'} (${cost.status}); invocation ${invocationId}`,
      );
    } catch (error) {
      failures += 1;
      io.err(`✖ ${String(i)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures === 0 ? 0 : 1;
}
