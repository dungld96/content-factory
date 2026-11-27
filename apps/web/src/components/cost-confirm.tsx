'use client';

import Link from 'next/link';

import { useT } from '@/components/i18n-provider';
import { Modal } from '@/components/modal';
import type { ConfirmReason } from '@/lib/cost-confirm';
import { formatUsd } from '@/lib/money';

export interface CostLine {
  readonly label: string;
  /** `null`: the price is unknown. */
  readonly usd: string | null;
}

/** "~$1.26", "~$1.26 + ?" or "?" for an estimate (unknown is never shown as $0). */
export function estimateText(totalUsd: string | null, unknown: boolean): string {
  if (totalUsd === null) return '?';
  return `~${formatUsd(totalUsd)}${unknown ? ' + ?' : ''}`;
}

/**
 * Confirmation before a paid action above the cost threshold or with an unknown price (redesign
 * R-D4): the lines, the total, why it asks, and where the threshold is changed.
 */
export function CostConfirmDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly lines: readonly CostLine[];
  readonly totalUsd: string | null;
  readonly unknown: boolean;
  readonly thresholdUsd: string;
  readonly reasons: readonly ConfirmReason[];
  /** The button's action, e.g. "Generate"; the total is appended. */
  readonly action: string;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  const total = estimateText(props.totalUsd, props.unknown);
  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      description={props.description}
    >
      <div className="cost-confirm" aria-label={t('cost.dialogLabel')}>
        <ul className="cost-lines">
          {props.lines.map((line, i) => (
            <li key={`${line.label}-${String(i)}`}>
              <span>{line.label}</span>
              <b className={line.usd === null ? 'unknown' : undefined}>
                {line.usd === null ? t('cost.unknownPrice') : `~${formatUsd(line.usd)}`}
              </b>
            </li>
          ))}
          <li className="cost-total">
            <span>{t('cost.estimated')}</span>
            <b>{total}</b>
          </li>
        </ul>
        {props.reasons.includes('threshold') && (
          <p className="small-text">
            {t('cost.reasonThreshold', {
              total: estimateText(props.totalUsd, false),
              threshold: formatUsd(props.thresholdUsd),
            })}{' '}
            <Link href="/settings/budgets">{t('cost.changeInSettings')}</Link>.
          </p>
        )}
        {props.reasons.includes('unknown') && (
          <p className="small-text warn-text">{t('cost.reasonUnknown')}</p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {t('cost.confirmLabel', { action: props.action, total })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
