// AI registry operator CLI (design package §8.1, decision E3). From the repository root:
//   pnpm ai:registry provider list
//   pnpm ai:registry provider set-status <key> <enabled|disabled|degraded>
//   pnpm ai:registry model list
//   pnpm ai:registry model set-status <modelKey> <status> [--provider openrouter]
//   pnpm ai:registry model import-openrouter <modelKey>... [--tier economy|balanced|premium] [--apply]
//   pnpm ai:registry price add <modelKey> <metric> <usdPerUnit> --source <source> --url <url>
//                              [--effective-from <ISO>] [--min-prompt-tokens <n>] [--provider openrouter]
//   pnpm ai:registry route list
//   pnpm ai:registry model import-openrouter-images <modelKey>... [--tier <tier>] [--endpoint <slug>] [--apply]
//   pnpm ai:registry route set <script_generation|storyboard_generation|image_generation|video_generation|tts_generation> <modelKey> [--provider openrouter] [--zdr]
//   pnpm ai:registry invocations mark-abandoned
//   pnpm ai:registry circuit list
//   pnpm ai:registry circuit <open|close> <providerKey>                                   (M7b)
//   ACF_PAID_SMOKE=1 pnpm ai:registry smoke <modelKey> --project <slug> --max-cost-usd <usd>
//   ACF_PAID_SMOKE=1 pnpm ai:registry smoke-image <modelKey> --project <slug> --max-cost-usd <usd>
//                              [--count <1-10>] [--resolution 2K] [--out <dir>]   (M4 benchmark)
//   pnpm ai:registry model import-openrouter-videos <modelKey>... [--tier <tier>] [--apply]   (M5)
//   pnpm ai:registry model import-openrouter-tts <modelKey>... [--tier <tier>] [--apply]      (M5)
//   pnpm ai:registry model set-min-billed-seconds <modelKey> <seconds|none> [--provider openrouter]
//   pnpm ai:registry model set-schema-mode <modelKey> <full|basic> [--provider openrouter]   (M8.5)
//   ACF_PAID_SMOKE=1 pnpm ai:registry smoke-video <modelKey> --project <slug> --max-cost-usd <usd>
//                              [--frame <png|jpg>] [--duration <s>] [--resolution 720p] [--count n] [--out <dir>]
//   ACF_PAID_SMOKE=1 pnpm ai:registry smoke-tts <modelKey> --voice <id> --project <slug> --max-cost-usd <usd>
//                              [--text "…"] [--count n] [--out <dir>]                 (M5 benchmark)
// Runs as the runtime role (DATABASE_URL). The import only reads OpenRouter's public catalog and
// writes nothing without --apply. `smoke` makes ONE real, paid call and is refused unless
// explicitly enabled and capped.
import 'reflect-metadata';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  activePrices,
  priceFor,
  PriceMetric,
  UsdAmount,
  type GenerationContext,
  type LlmUsage,
} from '@acf/ai-core';
import {
  CircuitBreaker,
  createImageProviders,
  createLlmProviders,
  ImageConstraintError,
  ImageService,
  LlmService,
  ModelCatalog,
  RoutingError,
  toPriceComponents,
} from '@acf/ai-runtime';
import { loadApiEnv } from '@acf/config';
import {
  createPrismaClient,
  type AiPriceSource,
  type AiProviderStatus,
  type AiQualityTier,
  type PrismaClient,
} from '@acf/database';

import { catalogUrl, planOpenRouterImport } from '../ai/providers/openrouter-catalog.js';
import {
  imageEndpointsUrl,
  planOpenRouterImageImport,
} from '../ai/providers/openrouter-image-catalog.js';
import { estimateImageCost, IMAGE_RESOLUTIONS, type ImageResolution } from '@acf/ai-core';
import {
  planOpenRouterTtsImport,
  planOpenRouterVideoImport,
  type MediaPlanEntry,
} from '../ai/providers/openrouter-media-catalog.js';
import { smokeTts, smokeVideo } from './media-smoke.js';
import { inspectImage } from '@acf/storage';
import { RegistryAdminError, RegistryAdminService } from '../ai/registry/registry-admin.service.js';

const STATUSES = new Set<string>(['enabled', 'disabled', 'degraded']);
const TIERS = new Set<string>(['economy', 'balanced', 'premium']);
const SOURCES = new Set<string>(['official_api', 'official_page', 'manual_estimate']);
const METRICS = new Set<string>(Object.values(PriceMetric));
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Job kinds an operator can route (`route set`). */
const ROUTABLE_TASKS = [
  'script_generation',
  'storyboard_generation',
  'image_generation',
  'video_generation',
  'tts_generation',
] as const;

/** Fixed smoke prompt: small and known, so the worst-case cost is bounded before sending. */
export const SMOKE_MESSAGES = [
  { role: 'system' as const, content: 'You are a connectivity check.' },
  { role: 'user' as const, content: 'Reply with the single word: ok' },
];
export const SMOKE_MAX_OUTPUT_TOKENS = 16;
/** Allowance for chat formatting tokens around the messages. */
const SMOKE_PROMPT_OVERHEAD_TOKENS = 32;
/**
 * OpenRouter prices are per upstream endpoint; the registry holds the catalog's default-endpoint
 * price, and the endpoint that serves the call may be dearer (verification record §5.1). The cap
 * check therefore multiplies the worst case by this factor.
 */
export const SMOKE_PRICE_SAFETY_FACTOR = 10;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Upper bound of the smoke call's cost (with the safety factor); null when a price is unknown. */
export function smokeWorstCase(prices: Parameters<typeof priceFor>[0]): UsdAmount | null {
  // Tokens never exceed UTF-8 bytes for the tokenizers in use; plus formatting overhead.
  const promptTokens =
    SMOKE_MESSAGES.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0) +
    SMOKE_PROMPT_OVERHEAD_TOKENS;
  const input = priceFor(prices, PriceMetric.INPUT_TOKENS, promptTokens);
  const output = priceFor(prices, PriceMetric.OUTPUT_TOKENS, promptTokens);
  if (!input || !output) return null;
  const reasoning = priceFor(prices, PriceMetric.REASONING_TOKENS, promptTokens);
  const outputUnit =
    reasoning && reasoning.unitPrice.compare(output.unitPrice) > 0
      ? reasoning.unitPrice
      : output.unitPrice;
  const request = priceFor(prices, PriceMetric.REQUEST, promptTokens);
  return UsdAmount.sum([
    input.unitPrice.times(promptTokens),
    outputUnit.times(SMOKE_MAX_OUTPUT_TOKENS),
    request?.unitPrice ?? UsdAmount.ZERO,
  ]).times(SMOKE_PRICE_SAFETY_FACTOR);
}

const usageLine = (u: LlmUsage) =>
  `input ${String(u.inputTokens)} (cached ${String(u.cachedInputTokens)}, cache-write ${String(u.cacheWriteTokens)}), output ${String(u.outputTokens)} (reasoning ${String(u.reasoningTokens)})`;

/** Parses options; throws on unknown or malformed options (reported as usage errors). */
function parseCliArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: 'string', default: 'openrouter' },
      tier: { type: 'string' },
      apply: { type: 'boolean', default: false },
      source: { type: 'string' },
      url: { type: 'string' },
      'effective-from': { type: 'string' },
      'min-prompt-tokens': { type: 'string' },
      project: { type: 'string' },
      'max-cost-usd': { type: 'string' },
      endpoint: { type: 'string' },
      count: { type: 'string' },
      resolution: { type: 'string' },
      out: { type: 'string' },
      zdr: { type: 'boolean', default: false },
      duration: { type: 'string' },
      frame: { type: 'string' },
      voice: { type: 'string' },
      text: { type: 'string' },
    },
  });
}

export async function runAiRegistryCli(
  argv: readonly string[],
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const [group, command, ...rest] = argv;
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(rest);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const { values, positionals } = parsed;
  const admin = new RegistryAdminService(prisma);
  const usage = (message: string) => {
    io.err(message);
    return 2;
  };

  try {
    if (group === 'provider' && command === 'list') {
      for (const p of await prisma.aiProvider.findMany({ orderBy: { key: 'asc' } })) {
        io.out(`${p.key}\t${p.kind}\t${p.status}\t${p.name}`);
      }
      return 0;
    }
    if (group === 'circuit' && command === 'list') {
      const circuits = new Map(
        (await new CircuitBreaker(prisma).list()).map((c) => [c.providerId, c]),
      );
      for (const p of await prisma.aiProvider.findMany({ orderBy: { key: 'asc' } })) {
        const c = circuits.get(p.id);
        io.out(
          [
            p.key,
            c?.state ?? 'closed',
            `failures=${String(c?.consecutiveFailures ?? 0)}`,
            c?.retryAt ? `retry_at=${c.retryAt.toISOString()}` : '',
            c?.lastErrorCode ? `last_error=${c.lastErrorCode}` : '',
          ]
            .filter(Boolean)
            .join('\t'),
        );
      }
      return 0;
    }
    if (group === 'circuit' && (command === 'open' || command === 'close')) {
      const [key] = positionals;
      if (!key) return usage('circuit <open|close> <providerKey>');
      const provider = await prisma.aiProvider.findUnique({ where: { key } });
      if (!provider) return usage(`unknown provider ${key}`);
      const row = await new CircuitBreaker(prisma).set(
        provider.id,
        command === 'open' ? 'open' : 'closed',
        null,
      );
      io.out(
        row.state === 'open'
          ? `✔ circuit ${key} is open until ${row.retryAt?.toISOString() ?? '?'}`
          : `✔ circuit ${key} is closed`,
      );
      return 0;
    }
    if (group === 'provider' && command === 'set-status') {
      const [key, status] = positionals;
      if (!key || !status || !STATUSES.has(status))
        return usage('provider set-status <key> <enabled|disabled|degraded>');
      await admin.setProviderStatus(key, status as AiProviderStatus);
      io.out(`✔ provider ${key} is ${status}`);
      return 0;
    }
    if (group === 'model' && command === 'list') {
      const rows = await prisma.aiModel.findMany({
        include: { provider: true, prices: true },
        orderBy: [{ provider: { key: 'asc' } }, { modelKey: 'asc' }],
      });
      for (const m of rows) {
        const active = activePrices(toPriceComponents(m.prices), new Date())
          .map(
            (p) =>
              `${p.metric}${p.minPromptTokens ? `≥${String(p.minPromptTokens)}` : ''}=${p.unitPrice.toString()}`,
          )
          .sort()
          .join(' ');
        io.out(
          `${m.provider.key}\t${m.modelKey}\t${m.status}\t${m.qualityTier}\t${active || '(no prices: cost unknown)'}${m.schemaMode === 'basic' ? '\tschema=basic' : ''}`,
        );
      }
      return 0;
    }
    if (group === 'model' && command === 'set-status') {
      const [modelKey, status] = positionals;
      if (!modelKey || !status || !STATUSES.has(status))
        return usage('model set-status <modelKey> <enabled|disabled|degraded>');
      await admin.setModelStatus(values.provider, modelKey, status as AiProviderStatus);
      io.out(`✔ model ${values.provider}/${modelKey} is ${status}`);
      return 0;
    }
    if (group === 'model' && command === 'set-schema-mode') {
      const [modelKey, mode] = positionals;
      if (!modelKey || (mode !== 'full' && mode !== 'basic'))
        return usage('model set-schema-mode <modelKey> <full|basic>');
      await admin.setSchemaMode(values.provider, modelKey, mode);
      io.out(
        mode === 'basic'
          ? `✔ ${values.provider}/${modelKey}: structured output sends the schema's structure only`
          : `✔ ${values.provider}/${modelKey}: structured output sends the full schema`,
      );
      return 0;
    }
    if (group === 'model' && command === 'set-min-billed-seconds') {
      const [modelKey, raw] = positionals;
      const seconds = raw === 'none' ? null : Number(raw);
      if (
        !modelKey ||
        raw === undefined ||
        (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 600))
      ) {
        return usage('model set-min-billed-seconds <modelKey> <seconds 1-600|none>');
      }
      await admin.setMinBilledSeconds(values.provider, modelKey, seconds);
      io.out(
        seconds === null
          ? `✔ ${values.provider}/${modelKey}: no minimum billed duration`
          : `✔ ${values.provider}/${modelKey}: bills at least ${String(seconds)} s per clip`,
      );
      return 0;
    }
    if (group === 'model' && command === 'import-openrouter') {
      if (positionals.length === 0)
        return usage('model import-openrouter <modelKey>... [--tier <tier>] [--apply]');
      if (values.tier !== undefined && !TIERS.has(values.tier))
        return usage('--tier must be economy, balanced or premium');
      const baseUrl = rawEnv['OPENROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
      let plan: Awaited<ReturnType<typeof planOpenRouterImport>>;
      try {
        plan = await planOpenRouterImport(baseUrl, positionals);
      } catch (error) {
        io.err(`✖ ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      for (const entry of plan) {
        if (!entry.ok) {
          io.out(`✖ ${entry.modelKey}: ${entry.reason}`);
          continue;
        }
        const prices = entry.model.prices
          .map(
            (p) =>
              `${p.metric}${p.minPromptTokens ? `≥${String(p.minPromptTokens)}` : ''}=${p.sourceValue}`,
          )
          .join(' ');
        io.out(
          `• ${entry.modelKey}: ${prices}; parameters [${entry.model.supportedParameters.join(', ')}]`,
        );
        for (const warning of entry.model.warnings) io.out(`  ! ${warning}`);
      }
      if (!values.apply) {
        io.out('(dry run: nothing written; pass --apply to write)');
        return plan.every((e) => e.ok) ? 0 : 1;
      }
      const outcomes = await admin.applyOpenRouterImport(plan, {
        ...(values.tier ? { tier: values.tier as AiQualityTier } : {}),
        sourceUrl: catalogUrl(baseUrl),
      });
      for (const o of outcomes) {
        io.out(
          `${o.action === 'refused' ? '✖' : '✔'} ${o.modelKey}: ${o.action}, ${String(o.newPrices)} new price row(s)`,
        );
        for (const line of o.detail) io.out(`  ${line}`);
      }
      return outcomes.every((o) => o.action !== 'refused') ? 0 : 1;
    }
    if (group === 'model' && command === 'import-openrouter-images') {
      if (positionals.length === 0)
        return usage(
          'model import-openrouter-images <modelKey>... [--tier <tier>] [--endpoint <slug>] [--apply]',
        );
      if (values.tier !== undefined && !TIERS.has(values.tier))
        return usage('--tier must be economy, balanced or premium');
      const baseUrl = rawEnv['OPENROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
      let plan: Awaited<ReturnType<typeof planOpenRouterImageImport>>;
      try {
        plan = await planOpenRouterImageImport(baseUrl, positionals, values.endpoint);
      } catch (error) {
        io.err(`✖ ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      for (const entry of plan) {
        if (!entry.ok) {
          io.out(`✖ ${entry.modelKey}: ${entry.reason}`);
          continue;
        }
        const { constraints: c, prices } = entry.model;
        io.out(
          `• ${entry.modelKey} @${entry.model.endpoint}: ${prices.map((p) => `${p.metric}${p.variant ? `[${p.variant}]` : ''}=${p.sourceValue}`).join(' ')}`,
        );
        io.out(
          `  n≤${String(c.maxImages)}, references≤${String(c.maxReferences)}, ratios [${c.aspectRatios.join(', ')}], resolutions [${c.resolutions.join(', ')}], seed ${c.seed ? 'yes' : 'no'}`,
        );
        for (const warning of entry.model.warnings) io.out(`  ! ${warning}`);
      }
      if (!values.apply) {
        io.out('(dry run: nothing written; pass --apply to write)');
        return plan.every((e) => e.ok) ? 0 : 1;
      }
      const outcomes = await admin.applyOpenRouterImageImport(plan, {
        ...(values.tier ? { tier: values.tier as AiQualityTier } : {}),
        sourceUrl: (modelKey) => imageEndpointsUrl(baseUrl, modelKey),
      });
      for (const o of outcomes) {
        io.out(
          `${o.action === 'refused' ? '✖' : '✔'} ${o.modelKey}: ${o.action}, ${String(o.newPrices)} new price row(s)`,
        );
        for (const line of o.detail) io.out(`  ${line}`);
      }
      return outcomes.every((o) => o.action !== 'refused') ? 0 : 1;
    }
    if (
      group === 'model' &&
      (command === 'import-openrouter-videos' || command === 'import-openrouter-tts')
    ) {
      const video = command === 'import-openrouter-videos';
      if (positionals.length === 0)
        return usage(`model ${command} <modelKey>... [--tier <tier>] [--apply]`);
      if (values.tier !== undefined && !TIERS.has(values.tier))
        return usage('--tier must be economy, balanced or premium');
      const baseUrl = rawEnv['OPENROUTER_BASE_URL'] ?? DEFAULT_BASE_URL;
      let plan: MediaPlanEntry[];
      try {
        plan = video
          ? await planOpenRouterVideoImport(baseUrl, positionals)
          : await planOpenRouterTtsImport(baseUrl, positionals);
      } catch (error) {
        io.err(`✖ ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      for (const entry of plan) {
        if (!entry.ok) {
          io.out(`✖ ${entry.modelKey}: ${entry.reason}`);
          continue;
        }
        const { constraints: c, prices } = entry.model;
        io.out(
          `• ${entry.modelKey}: ${prices.map((p) => `${p.metric}${p.variant ? `[${p.variant}]` : ''}=${p.unitPrice.toString()}`).join(' ') || 'no prices'}`,
        );
        io.out(
          c.kind === 'video'
            ? `  durations [${c.durations.join(', ')}] s, resolutions [${c.resolutions.join(', ')}], ratios [${c.aspectRatios.join(', ')}], frames [${c.frameImages.join(', ')}], audio ${String(c.audio)}, seed ${c.seed ? 'yes' : 'no'}`
            : `  ${String(c.voices.length)} voice(s)${c.voices.length > 0 ? ` (${c.voices.slice(0, 6).join(', ')}${c.voices.length > 6 ? ', …' : ''})` : ''}, ${c.mp3 ? 'mp3' : 'pcm only'}`,
        );
        for (const warning of entry.model.warnings) io.out(`  ! ${warning}`);
      }
      if (!values.apply) {
        io.out('(dry run: nothing written; pass --apply to write)');
        return plan.every((e) => e.ok) ? 0 : 1;
      }
      const outcomes = await admin.applyOpenRouterMediaImport(plan, {
        ...(values.tier ? { tier: values.tier as AiQualityTier } : {}),
        sourceUrl: () =>
          video ? `${baseUrl}/videos/models` : `${baseUrl}/models?output_modalities=speech`,
      });
      for (const o of outcomes) {
        io.out(
          `${o.action === 'refused' ? '✖' : '✔'} ${o.modelKey}: ${o.action}, ${String(o.newPrices)} new price row(s)`,
        );
        for (const line of o.detail) io.out(`  ${line}`);
      }
      return outcomes.every((o) => o.action !== 'refused') ? 0 : 1;
    }
    if (group === 'price' && command === 'add') {
      const [modelKey, metric, usd] = positionals;
      if (
        !modelKey ||
        !metric ||
        !usd ||
        !METRICS.has(metric) ||
        !values.source ||
        !SOURCES.has(values.source) ||
        !values.url
      ) {
        return usage(
          'price add <modelKey> <metric> <usdPerUnit> --source <official_api|official_page|manual_estimate> --url <url>',
        );
      }
      const effectiveFrom = values['effective-from']
        ? new Date(values['effective-from'])
        : undefined;
      if (effectiveFrom && Number.isNaN(effectiveFrom.getTime()))
        return usage('--effective-from must be an ISO date-time');
      const minPromptTokens = values['min-prompt-tokens']
        ? Number(values['min-prompt-tokens'])
        : undefined;
      if (
        minPromptTokens !== undefined &&
        (!Number.isSafeInteger(minPromptTokens) || minPromptTokens < 0)
      ) {
        return usage('--min-prompt-tokens must be a non-negative integer');
      }
      const id = await admin.addPrice({
        providerKey: values.provider,
        modelKey,
        metric: metric as PriceMetric,
        usdPerUnit: usd,
        source: values.source as AiPriceSource,
        sourceUrl: values.url,
        ...(effectiveFrom ? { effectiveFrom } : {}),
        ...(minPromptTokens === undefined ? {} : { minPromptTokens }),
      });
      io.out(`✔ price ${id} appended (existing rows are never changed)`);
      return 0;
    }
    if (group === 'route' && command === 'list') {
      for (const r of await prisma.aiTaskRoute.findMany({
        include: { model: { include: { provider: true } } },
        orderBy: { task: 'asc' },
      })) {
        io.out(
          `${r.task}\t${r.model.provider.key}/${r.model.modelKey}\t${r.model.status}${r.zeroDataRetention ? '\tzdr' : ''}`,
        );
      }
      return 0;
    }
    if (group === 'route' && command === 'set') {
      const [task, modelKey] = positionals;
      if (!task || !(ROUTABLE_TASKS as readonly string[]).includes(task) || !modelKey) {
        return usage(`route set <${ROUTABLE_TASKS.join('|')}> <modelKey> [--provider <key>]`);
      }
      const { enabled } = await admin.setRoute(
        task as (typeof ROUTABLE_TASKS)[number],
        values.provider,
        modelKey,
        values.zdr,
      );
      io.out(
        `✔ ${task} → ${values.provider}/${modelKey}${values.zdr ? ' (zero data retention)' : ''}`,
      );
      if (!enabled)
        io.out('  ! the model or provider is not enabled: generation refuses until it is');
      return 0;
    }
    if (group === 'invocations' && command === 'mark-abandoned') {
      const env = loadApiEnv(rawEnv);
      const providers = createLlmProviders(env);
      const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
        providerTimeoutMs: env.OPENROUTER_TIMEOUT_MS,
      });
      const count = await llm.markAbandoned();
      io.out(
        `✔ ${String(count)} abandoned invocation(s) marked outcome_unknown (never re-sent automatically)`,
      );
      return 0;
    }
    if (group === 'smoke') {
      return await smoke(command, values, prisma, rawEnv, io);
    }
    if (group === 'smoke-image') {
      return await smokeImage(command, values, prisma, rawEnv, io);
    }
    if (group === 'smoke-video') {
      return await smokeVideo(command, values, prisma, rawEnv, io);
    }
    if (group === 'smoke-tts') {
      return await smokeTts(command, values, prisma, rawEnv, io);
    }
    return usage(
      'usage: ai:registry provider|model|price|smoke … (see the header of src/cli/ai-registry-cli.ts)',
    );
  } catch (error) {
    if (error instanceof RegistryAdminError || error instanceof RoutingError) {
      io.err(`✖ ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function smoke(
  modelKey: string | undefined,
  values: { provider: string; project?: string | undefined; 'max-cost-usd'?: string | undefined },
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  if (rawEnv['ACF_PAID_SMOKE'] !== '1') {
    io.err('✖ refused: the smoke test makes a real, paid call. Set ACF_PAID_SMOKE=1 to enable it.');
    return 2;
  }
  if (!modelKey || !values.project || !values['max-cost-usd']) {
    io.err('smoke <modelKey> --project <slug> --max-cost-usd <usd>');
    return 2;
  }
  let cap: UsdAmount;
  try {
    cap = UsdAmount.parse(values['max-cost-usd']);
  } catch {
    io.err('--max-cost-usd must be a non-negative decimal');
    return 2;
  }
  const env = loadApiEnv(rawEnv);
  const providers = createLlmProviders(env);
  if (!providers.has(values.provider)) {
    io.err(`✖ refused: provider ${values.provider} has no credentials (OPENROUTER_API_KEY).`);
    return 2;
  }
  const model = await prisma.aiModel.findFirst({
    where: { modelKey, provider: { key: values.provider } },
    include: { prices: true },
  });
  if (!model) {
    io.err(`✖ unknown model ${values.provider}/${modelKey} (import it first)`);
    return 1;
  }
  const worst = smokeWorstCase(activePrices(toPriceComponents(model.prices), new Date()));
  if (worst === null) {
    io.err('✖ refused: input/output prices are unknown, so the cost cannot be capped.');
    return 2;
  }
  if (worst.compare(cap) > 0) {
    io.err(
      `✖ refused: worst case ${worst.toString()} USD exceeds --max-cost-usd ${cap.toString()}.`,
    );
    return 2;
  }
  const project = await prisma.project.findUnique({
    where: { slug: values.project },
    select: { id: true },
  });
  if (!project) {
    io.err(`✖ unknown project ${values.project}`);
    return 1;
  }

  const llm = new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: env.OPENROUTER_TIMEOUT_MS,
  });
  const context: GenerationContext = {
    projectId: project.id,
    correlationId: `smoke-${String(Date.now())}`,
    qualityTier: 'economy',
  };
  io.out(`→ one paid call to ${values.provider}/${modelKey} (worst case ${worst.toString()} USD)`);
  try {
    const result = await llm.complete(
      context,
      { modelKey, messages: SMOKE_MESSAGES, maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS },
      { providerKey: values.provider, allowDisabled: true },
    );
    const invocation = await prisma.aiInvocation.findFirstOrThrow({
      where: { correlationId: context.correlationId },
      select: { id: true, costStatus: true, estimatedCost: true },
    });
    io.out(`✔ ${result.finishReason}: ${JSON.stringify(result.text.slice(0, 80))}`);
    io.out(
      `  generation ${result.providerRequestId}, served ${result.servedModel}, ${String(result.latencyMs)} ms`,
    );
    io.out(`  usage: ${usageLine(result.usage)}`);
    io.out(`  reported cost: ${result.reportedCost?.toString() ?? 'not reported'} USD`);
    io.out(
      `  estimated cost: ${invocation.estimatedCost === null ? 'unknown' : UsdAmount.parse(invocation.estimatedCost.toFixed()).toString()} USD (cost status ${invocation.costStatus})`,
    );
    io.out(
      `  invocation ${invocation.id}. Compare reported vs estimated to check assumptions A1–A3.`,
    );
    return 0;
  } catch (error) {
    io.err(`✖ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Fixed benchmark prompt (M4 design §3.3): a 9:16 product scene with no people or text. */
export const SMOKE_IMAGE_PROMPT =
  'Vertical product photo: a tidy wooden desk with a small desk lamp, a wireless charger and a ' +
  'notebook, soft morning light from a window, shallow depth of field, no people, no text.';
/** Per-endpoint prices can differ from the imported one; the cap check allows for that. */
export const SMOKE_IMAGE_SAFETY_FACTOR = 2;

async function smokeImage(
  modelKey: string | undefined,
  values: {
    provider: string;
    project?: string | undefined;
    'max-cost-usd'?: string | undefined;
    count?: string | undefined;
    resolution?: string | undefined;
    out?: string | undefined;
  },
  prisma: PrismaClient,
  rawEnv: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  if (rawEnv['ACF_PAID_SMOKE'] !== '1') {
    io.err('✖ refused: smoke-image makes real, paid calls. Set ACF_PAID_SMOKE=1 to enable it.');
    return 2;
  }
  if (!modelKey || !values.project || !values['max-cost-usd']) {
    io.err(
      'smoke-image <modelKey> --project <slug> --max-cost-usd <usd> [--count n] [--resolution 2K] [--out dir]',
    );
    return 2;
  }
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    io.err('--count must be an integer from 1 to 10');
    return 2;
  }
  const resolution = values.resolution as ImageResolution | undefined;
  if (resolution !== undefined && !(IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
    io.err(`--resolution must be one of ${IMAGE_RESOLUTIONS.join(', ')}`);
    return 2;
  }
  let cap: UsdAmount;
  try {
    cap = UsdAmount.parse(values['max-cost-usd']);
  } catch {
    io.err('--max-cost-usd must be a non-negative decimal');
    return 2;
  }
  const env = loadApiEnv(rawEnv);
  const providers = createImageProviders(env);
  if (!providers.has(values.provider)) {
    io.err(`✖ refused: provider ${values.provider} has no credentials (OPENROUTER_API_KEY).`);
    return 2;
  }
  const project = await prisma.project.findUnique({
    where: { slug: values.project },
    select: { id: true },
  });
  if (!project) {
    io.err(`✖ unknown project ${values.project}`);
    return 1;
  }
  const images = new ImageService(
    prisma,
    new ModelCatalog(prisma, new Map(), providers),
    providers,
    {
      pixelsOf: (bytes) => {
        try {
          const i = inspectImage(bytes);
          return i.width * i.height;
        } catch {
          return null;
        }
      },
    },
  );
  const request = {
    modelKey,
    prompt: SMOKE_IMAGE_PROMPT,
    aspectRatio: '9:16' as const,
    count: 1,
    references: [],
    ...(resolution ? { resolution } : {}),
  };
  let worst: UsdAmount | null;
  try {
    const { row } = await images.route({ qualityTier: 'economy' }, request, {
      providerKey: values.provider,
      allowDisabled: true,
    });
    const one = estimateImageCost({
      prices: activePrices(row.prices, new Date()),
      count: 1,
      references: 0,
      resolution,
      aspectRatio: '9:16',
    });
    worst = one === null ? null : one.times(count).times(SMOKE_IMAGE_SAFETY_FACTOR);
  } catch (error) {
    if (error instanceof RoutingError || error instanceof ImageConstraintError) {
      io.err(`✖ ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (worst === null) {
    io.err(
      '✖ refused: the per-image price is unknown (token-priced?), so the cost cannot be capped.',
    );
    return 2;
  }
  if (worst.compare(cap) > 0) {
    io.err(
      `✖ refused: worst case ${worst.toString()} USD exceeds --max-cost-usd ${cap.toString()}.`,
    );
    return 2;
  }
  const outDir = path.resolve(values.out ?? 'smoke-images');
  await mkdir(outDir, { recursive: true });
  io.out(
    `→ ${String(count)} paid image call(s) to ${values.provider}/${modelKey} (worst case ${worst.toString()} USD)`,
  );
  let failures = 0;
  for (let i = 1; i <= count; i++) {
    const correlationId = `smoke-image-${String(Date.now())}-${String(i)}`;
    try {
      const { result, cost, invocationId } = await images.generate(
        { projectId: project.id, correlationId, qualityTier: 'economy' },
        request,
        { providerKey: values.provider, allowDisabled: true },
      );
      for (const [n, image] of result.images.entries()) {
        const inspected = inspectImage(image.bytes, image.declaredType);
        const file = path.join(
          outDir,
          `${modelKey.replace(/[^a-z0-9._-]+/gi, '_')}-${String(i)}-${String(n)}.${inspected.mimeType.split('/')[1] ?? 'img'}`,
        );
        await writeFile(file, image.bytes);
        io.out(
          `✔ ${String(i)}: ${String(inspected.width)}×${String(inspected.height)} ${inspected.mimeType}, ${String(result.latencyMs)} ms → ${file}`,
        );
      }
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

async function main(): Promise<number> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (see .env.example).');
    return 2;
  }
  const prisma = createPrismaClient({ databaseUrl, maxConnections: 1 });
  try {
    return await runAiRegistryCli(process.argv.slice(2), prisma, process.env, {
      out: (line) => {
        console.info(line);
      },
      err: (line) => {
        console.error(line);
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (tests import runAiRegistryCli).
if (process.argv[1]?.endsWith('ai-registry-cli.js')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
