import type { MutationResult } from './api-client';
import { translator, type Translate } from './i18n';
import { formatUsd } from './money';

/** The consents a resume request can carry (`ResumeRunRequest`, M7c). */
export interface ResumeBody {
  readonly confirmedEstimateUsd?: string | null;
  readonly acceptUnknownCost?: boolean;
  readonly acceptPossibleDoubleCharge?: boolean;
}

export type ResumeStep =
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly text: string;
      readonly next: ResumeBody;
    }
  | { readonly kind: 'error'; readonly text: string };

/** At most this many consents are asked for one resume (estimate, unknown cost, double charge). */
export const MAX_RESUME_ROUNDS = 3;

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * What to do after a refused resume (P3 design W1): ask for the one consent the API named, by
 * error code and `error.current`, or show the error. Never decided by the message text.
 * (A soft budget is confirmed by `mutate()` itself.)
 */
export function nextResumeStep(
  result: MutationResult<unknown>,
  body: ResumeBody,
  t: Translate = translator('en'),
): ResumeStep {
  const current = record(result.current);
  const fallback = result.message ?? t('form.requestFailed', { status: result.status });

  if (result.code === 'ESTIMATE_CHANGED' && current && !('confirmedEstimateUsd' in body)) {
    const total =
      typeof current['totalEstimatedUsd'] === 'string' ? current['totalEstimatedUsd'] : null;
    const scenes = Array.isArray(current['scenes'])
      ? current['scenes'].filter((s) => record(s)?.['action'] === 'generate').length
      : 0;
    const what = t('resume.clips', { count: scenes });
    return {
      kind: 'confirm',
      title: t('resume.confirmClipTitle'),
      text:
        total === null
          ? t('resume.clipUnknown', { what })
          : t('resume.clipKnown', { what, total: formatUsd(total) }),
      next: {
        ...body,
        confirmedEstimateUsd: total,
        ...(total === null ? { acceptUnknownCost: true } : {}),
      },
    };
  }
  if (result.code === 'UNKNOWN_COST_NOT_ACCEPTED' && !body.acceptUnknownCost) {
    return {
      kind: 'confirm',
      title: t('resume.unknownTitle'),
      text: t('resume.unknownText'),
      next: { ...body, acceptUnknownCost: true },
    };
  }
  if (result.code === 'NOTHING_TO_RESUME' && !body.acceptPossibleDoubleCharge) {
    const skipped = Array.isArray(current?.['skipped']) ? current['skipped'] : [];
    const charged = skipped.filter((s) => record(s)?.['reason'] === 'outcome_unknown').length;
    if (charged > 0) {
      return {
        kind: 'confirm',
        title: t('resume.chargedTitle'),
        text: t('resume.chargedText', { count: charged }),
        next: { ...body, acceptPossibleDoubleCharge: true },
      };
    }
    return {
      kind: 'error',
      text: t('resume.nothingLeft'),
    };
  }
  return { kind: 'error', text: fallback };
}
