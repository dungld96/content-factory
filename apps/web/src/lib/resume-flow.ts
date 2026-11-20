import type { MutationResult } from './api-client';
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
export function nextResumeStep(result: MutationResult<unknown>, body: ResumeBody): ResumeStep {
  const current = record(result.current);
  const fallback = result.message ?? `Request failed (HTTP ${String(result.status)})`;

  if (result.code === 'ESTIMATE_CHANGED' && current && !('confirmedEstimateUsd' in body)) {
    const total =
      typeof current['totalEstimatedUsd'] === 'string' ? current['totalEstimatedUsd'] : null;
    const scenes = Array.isArray(current['scenes'])
      ? current['scenes'].filter((s) => record(s)?.['action'] === 'generate').length
      : 0;
    const what = `${String(scenes)} clip${scenes === 1 ? '' : 's'}`;
    return {
      kind: 'confirm',
      title: 'Confirm the clip cost',
      text:
        total === null
          ? `Resuming generates ${what}. Their cost is unknown; up to USD 0.50 per call is reserved from the budget.`
          : `Resuming generates ${what} for about ${formatUsd(total)} (estimate).`,
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
      title: 'Confirm unknown cost',
      text: 'Some calls have no known price. Up to USD 0.50 per call is reserved from the budget.',
      next: { ...body, acceptUnknownCost: true },
    };
  }
  if (result.code === 'NOTHING_TO_RESUME' && !body.acceptPossibleDoubleCharge) {
    const skipped = Array.isArray(current?.['skipped']) ? current['skipped'] : [];
    const charged = skipped.filter((s) => record(s)?.['reason'] === 'outcome_unknown').length;
    if (charged > 0) {
      return {
        kind: 'confirm',
        title: 'Possibly charged already',
        text: `${String(charged)} job${charged === 1 ? '' : 's'} ended without knowing whether the provider accepted the call. Resuming may be charged twice.`,
        next: { ...body, acceptPossibleDoubleCharge: true },
      };
    }
    return {
      kind: 'error',
      text: 'Nothing to resume: the failed work was already redone or is running again.',
    };
  }
  return { kind: 'error', text: fallback };
}
