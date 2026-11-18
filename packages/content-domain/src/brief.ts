import type { RuleIssue } from './issues.js';

/** Brief fields used by validation (the stored brief JSON plus content-item settings). */
export interface BriefInput {
  readonly topic: string;
  readonly audience?: string | undefined;
  readonly objective?: string | undefined;
  readonly tone?: string | undefined;
  readonly callToAction?: string | undefined;
  readonly notes?: string | undefined;
  readonly sourceUrls?: readonly string[] | undefined;
  readonly format: 'short_video';
  readonly targetDurationSeconds: number;
  readonly language: string;
  readonly aspectRatio: string;
  /** Referenced character/environment and whether it has an approved master version. */
  readonly character?: { readonly id: string; readonly hasApprovedMaster: boolean } | undefined;
  readonly environment?: { readonly id: string; readonly hasApprovedMaster: boolean } | undefined;
}

export interface NormalizedBrief {
  readonly topic: string;
  readonly audience: string | null;
  readonly objective: string | null;
  readonly tone: string | null;
  readonly callToAction: string | null;
  readonly notes: string | null;
  readonly sourceUrls: readonly string[];
  readonly targetDurationSeconds: number;
  readonly language: string;
  readonly aspectRatio: string;
}

export interface BriefValidation {
  readonly normalized: NormalizedBrief;
  /** Block generation; the content item goes to `needs_input`. */
  readonly errors: readonly RuleIssue[];
  /** Shown to the editor; generation may proceed. */
  readonly warnings: readonly RuleIssue[];
  /** Commercial/sensitive claim terms found; the script must list claims requiring verification. */
  readonly flags: readonly string[];
}

/** Short-video duration range for generation (M3 design §5.1). */
export const SHORT_VIDEO_SECONDS = { min: 5, max: 180 } as const;

/**
 * Claim-like terms (English and Vietnamese, the pilot language). A heuristic: it only raises
 * flags/warnings, it never blocks. Matching is case-insensitive on word boundaries.
 */
const CLAIM_TERMS: readonly string[] = [
  'price',
  'cheapest',
  'best',
  'discount',
  'sale',
  'guarantee',
  'cure',
  'clinically',
  'invest',
  'return',
  'profit',
  '%',
  'giá',
  'rẻ nhất',
  'tốt nhất',
  'giảm giá',
  'khuyến mãi',
  'cam kết',
  'chữa',
  'đầu tư',
  'lợi nhuận',
];

const clean = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

function claimTermsIn(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  return CLAIM_TERMS.filter((term) =>
    term === '%'
      ? lower.includes('%')
      : new RegExp(
          `(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`,
          'u',
        ).test(lower),
  );
}

/** Stage 1 (CONTENT_PIPELINE §2): deterministic, no LLM call. */
export function validateBrief(input: BriefInput): BriefValidation {
  const normalized: NormalizedBrief = {
    topic: input.topic.trim(),
    audience: clean(input.audience),
    objective: clean(input.objective),
    tone: clean(input.tone),
    callToAction: clean(input.callToAction),
    notes: clean(input.notes),
    sourceUrls: [...new Set((input.sourceUrls ?? []).map((u) => u.trim()).filter(Boolean))],
    targetDurationSeconds: input.targetDurationSeconds,
    language: input.language,
    aspectRatio: input.aspectRatio,
  };

  const errors: RuleIssue[] = [];
  if (normalized.topic.length === 0) errors.push({ path: 'brief.topic', message: 'is required' });
  if (
    input.targetDurationSeconds < SHORT_VIDEO_SECONDS.min ||
    input.targetDurationSeconds > SHORT_VIDEO_SECONDS.max
  ) {
    errors.push({
      path: 'targetDurationSeconds',
      message: `must be ${String(SHORT_VIDEO_SECONDS.min)}–${String(SHORT_VIDEO_SECONDS.max)} s for a short video`,
    });
  }
  if (input.character && !input.character.hasApprovedMaster) {
    errors.push({
      path: 'brief.characterId',
      message: 'the character has no approved master version',
    });
  }
  if (input.environment && !input.environment.hasApprovedMaster) {
    errors.push({
      path: 'brief.environmentId',
      message: 'the environment has no approved master version',
    });
  }

  const warnings: RuleIssue[] = [];
  for (const field of ['audience', 'objective', 'tone', 'callToAction'] as const) {
    if (normalized[field] === null) {
      warnings.push({ path: `brief.${field}`, message: 'not set; the model will choose' });
    }
  }
  const flags = [
    ...new Set(
      claimTermsIn(
        [normalized.topic, normalized.objective ?? '', normalized.notes ?? ''].join(' '),
      ),
    ),
  ];
  if (flags.length > 0 && normalized.sourceUrls.length === 0) {
    warnings.push({
      path: 'brief.sourceUrls',
      message: 'claim-like terms without sources: factual claims will be listed for verification',
    });
  }
  return { normalized, errors, warnings, flags };
}
