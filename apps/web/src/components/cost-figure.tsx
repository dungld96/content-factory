import type { CostFigureDto } from '@acf/contracts';

import type { Translate } from '@/lib/i18n';
import { formatUsd } from '@/lib/money';

/**
 * Reported, estimated, held and unknown kept apart (M7 B9): unknown cost is never shown as $0.
 * Server component: the caller passes its translator.
 */
export function CostFigure({ cost, t }: { readonly cost: CostFigureDto; readonly t: Translate }) {
  const parts = [t('costs.reportedPart', { amount: formatUsd(cost.reportedUsd) })];
  if (cost.estimatedUsd !== '0')
    parts.push(t('costs.estimatedPart', { amount: formatUsd(cost.estimatedUsd) }));
  if (cost.heldUsd !== '0') parts.push(t('costs.heldPart', { amount: formatUsd(cost.heldUsd) }));
  if (cost.unknownCalls > 0) parts.push(t('costs.unknownPart', { count: cost.unknownCalls }));
  return (
    <>
      <b>{formatUsd(cost.totalUsd)}</b>
      <span className="muted small-text"> · {parts.join(' · ')}</span>
    </>
  );
}
