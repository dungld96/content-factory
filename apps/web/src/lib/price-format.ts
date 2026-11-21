import type { AiPriceDto } from '@acf/contracts';

/**
 * Human-readable AI prices for Settings. The registry stores USD per single unit (one token, one
 * pixel, one character); people compare prices per 1M tokens, per megapixel, per image or per
 * second. Scaling moves the decimal point of the exact string: no floating point (CLAUDE.md §5).
 */
const UNITS: Readonly<
  Record<
    AiPriceDto['metric'],
    { readonly label: string; readonly power: number; readonly unit: string }
  >
> = {
  input_tokens: { label: 'Input', power: 6, unit: '1M tokens' },
  output_tokens: { label: 'Output', power: 6, unit: '1M tokens' },
  cached_input_tokens: { label: 'Cached input', power: 6, unit: '1M tokens' },
  cache_write_tokens: { label: 'Cache write', power: 6, unit: '1M tokens' },
  reasoning_tokens: { label: 'Reasoning', power: 6, unit: '1M tokens' },
  request: { label: 'Request', power: 0, unit: 'request' },
  output_images: { label: 'Image', power: 0, unit: 'image' },
  input_images: { label: 'Input image', power: 0, unit: 'image' },
  output_pixels: { label: 'Output', power: 6, unit: 'megapixel' },
  input_pixels: { label: 'Input', power: 6, unit: 'megapixel' },
  output_image_tokens: { label: 'Image output', power: 6, unit: '1M tokens' },
  input_image_tokens: { label: 'Image input', power: 6, unit: '1M tokens' },
  output_video_seconds: { label: 'Video', power: 0, unit: 'second' },
  output_video_tokens: { label: 'Video', power: 6, unit: '1M tokens' },
  input_characters: { label: 'Text', power: 6, unit: '1M characters' },
};

/** Multiplies a non-negative decimal string by 10^power exactly ("0.00000015", 6 → "0.15"). */
export function shiftDecimal(amount: string, power: number): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const digits = whole + fraction.padEnd(power, '0');
  const point = whole.length + power;
  const intPart = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = digits.slice(point).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** "$0.15", "$1.20", "$3", "≈ $0.0833": at most 4 decimals, marked when shortened (half-up). */
export function displayUsd(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  if (fraction.length <= 4) {
    return `$${whole}${fraction ? `.${fraction.padEnd(2, '0')}` : ''}`;
  }
  const up = Number(fraction[4]) >= 5 ? 1n : 0n;
  const scaled = (BigInt(whole + fraction.slice(0, 4)) + up).toString().padStart(5, '0');
  const w = scaled.slice(0, -4);
  const f = scaled.slice(-4).replace(/0+$/, '');
  return `≈ $${w}${f ? `.${f.padEnd(2, '0')}` : ''}`;
}

export interface PriceLine {
  readonly id: string;
  /** e.g. "Input", "Video · 720p-silent", "Input (prompts ≥ 200K)". */
  readonly label: string;
  /** e.g. "$0.15 / 1M tokens". */
  readonly price: string;
}

export function priceLine(p: AiPriceDto): PriceLine {
  const unit = UNITS[p.metric];
  const tier =
    p.minPromptTokens > 0 ? ` (prompts ≥ ${String(Math.round(p.minPromptTokens / 1000))}K)` : '';
  const variant = p.variant ? ` · ${p.variant}` : '';
  return {
    id: p.id,
    label: `${unit.label}${variant}${tier}`,
    price: `${displayUsd(shiftDecimal(p.unitPriceUsd, unit.power))} / ${unit.unit}`,
  };
}

/** The prices people compare first: the base tier of the model's main metrics. */
const PRIMARY: ReadonlySet<AiPriceDto['metric']> = new Set([
  'input_tokens',
  'output_tokens',
  'output_images',
  'output_pixels',
  'output_image_tokens',
  'output_video_seconds',
  'input_characters',
]);

const ORDER = Object.keys(UNITS);

/** Prices in a stable reading order: input before output, then the rest (catalogue order). */
export function sortPrices(prices: readonly AiPriceDto[]): AiPriceDto[] {
  return [...prices].sort(
    (a, b) =>
      ORDER.indexOf(a.metric) - ORDER.indexOf(b.metric) ||
      a.minPromptTokens - b.minPromptTokens ||
      a.variant.localeCompare(b.variant),
  );
}

export function primaryPrices(prices: readonly AiPriceDto[]): PriceLine[] {
  return sortPrices(prices)
    .filter((p) => PRIMARY.has(p.metric) && p.minPromptTokens === 0)
    .map(priceLine)
    .slice(0, 3);
}

/** "128K", "1M", "1.5M": token counts at a glance. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${String(Math.round(n / 1_000))}K`;
  return String(n);
}
