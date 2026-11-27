import type { AiModelDto, AiPriceDto, AiRouteDto, AiTask } from '@acf/contracts';

import { addUsd, mulUsd } from './money';

/**
 * Estimated cost of a whole run before the content item exists (New content page, redesign
 * canvas "Estimated run cost"). Built from the routed models' current prices only; nothing is
 * called. The figures are planning numbers: every paid step still shows its own estimate (or
 * asks) before it runs, and the API reserves its own worst case.
 *
 * Unknown cost is never zero (CLAUDE.md §2.13): a step whose model has no price for the metric
 * it needs, or no routed model, is `null` and the total is marked as incomplete.
 */

/** Seconds per scene the storyboard aims for: a 30 s video has about 6 scenes. */
export const SECONDS_PER_SCENE = 5;
/** Text calls: prompt and answer sizes (tokens) used for the estimate. */
const TEXT_TOKENS = {
  script: { input: 2_000, output: 1_500 },
  storyboard: { input: 3_000, output: 3_000 },
} as const;
/** Narration speed used to size the voice-over (characters per second). */
const CHARS_PER_SECOND = 15;

export type RunStep = 'script' | 'storyboard' | 'keyframes' | 'clips' | 'voice' | 'render';

export interface RunLine {
  readonly step: RunStep;
  /** Display name of the routed model; `null` when nothing is routed. */
  readonly model: string | null;
  /** Exact decimal USD, or `null` when the cost is unknown. */
  readonly amountUsd: string | null;
}

export interface RunEstimate {
  readonly scenes: number;
  readonly lines: readonly RunLine[];
  /** Sum of the known lines. */
  readonly knownUsd: string;
  /** At least one line has an unknown cost. */
  readonly hasUnknown: boolean;
}

export interface RunInput {
  readonly durationSeconds: number;
  readonly candidatesPerScene: number;
  readonly routes: readonly AiRouteDto[];
  readonly models: readonly AiModelDto[];
  /** The TTS model of the chosen voice profile; `null` = voice-over off. */
  readonly voiceModelKey: string | null;
}

/** The price row for `metric`: the base tier (no prompt minimum, any variant) first. */
function priceOf(model: AiModelDto, metric: AiPriceDto['metric']): string | null {
  const rows = model.activePrices.filter((p) => p.metric === metric);
  const base =
    rows.find((p) => p.minPromptTokens === 0 && p.variant === '') ??
    rows.find((p) => p.minPromptTokens === 0) ??
    rows[0];
  return base ? base.unitPriceUsd : null;
}

function routed(input: RunInput, task: AiTask): AiModelDto | null {
  const key = input.routes.find((r) => r.task === task)?.model?.modelKey;
  return (key && input.models.find((m) => m.modelKey === key)) || null;
}

function textLine(input: RunInput, step: 'script' | 'storyboard', task: AiTask): RunLine {
  const model = routed(input, task);
  if (!model) return { step, model: null, amountUsd: null };
  const inPrice = priceOf(model, 'input_tokens');
  const outPrice = priceOf(model, 'output_tokens');
  const tokens = TEXT_TOKENS[step];
  return {
    step,
    model: model.displayName,
    amountUsd:
      inPrice && outPrice
        ? addUsd(mulUsd(inPrice, tokens.input), mulUsd(outPrice, tokens.output))
        : null,
  };
}

export function estimateRun(input: RunInput): RunEstimate {
  const scenes = Math.max(1, Math.round(input.durationSeconds / SECONDS_PER_SCENE));
  const image = routed(input, 'image_generation');
  const video = routed(input, 'video_generation');
  const imagePrice = image && priceOf(image, 'output_images');
  const videoPrice = video && priceOf(video, 'output_video_seconds');
  const lines: RunLine[] = [
    textLine(input, 'script', 'script_generation'),
    textLine(input, 'storyboard', 'storyboard_generation'),
    {
      step: 'keyframes',
      model: image?.displayName ?? null,
      amountUsd: imagePrice ? mulUsd(imagePrice, scenes * input.candidatesPerScene) : null,
    },
    {
      step: 'clips',
      model: video?.displayName ?? null,
      amountUsd: videoPrice ? mulUsd(videoPrice, scenes * SECONDS_PER_SCENE) : null,
    },
  ];
  if (input.voiceModelKey !== null) {
    const voice = input.models.find((m) => m.modelKey === input.voiceModelKey) ?? null;
    const charPrice = voice && priceOf(voice, 'input_characters');
    lines.push({
      step: 'voice',
      model: voice?.displayName ?? null,
      amountUsd: charPrice
        ? mulUsd(charPrice, Math.round(input.durationSeconds * CHARS_PER_SECOND))
        : null,
    });
  }
  // FFmpeg on the worker: no provider call.
  lines.push({ step: 'render', model: null, amountUsd: '0' });
  const known = lines.flatMap((l) => (l.amountUsd === null ? [] : [l.amountUsd]));
  return {
    scenes,
    lines,
    knownUsd: addUsd(...known),
    hasUnknown: lines.some((l) => l.amountUsd === null),
  };
}
