'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { formatUsd } from '@/lib/money';
import { projectSwatch } from '@/lib/project-swatch';

import { validThreshold } from './spending-form';

export interface OverrideRow {
  readonly projectId: string;
  readonly name: string;
  readonly canEdit: boolean;
  /** The project's override; null uses the workspace threshold. */
  readonly overrideUsd: string | null;
  readonly monthlyLimitUsd: string | null;
}

/**
 * Per-project cost-confirmation thresholds, edited in place (redesign canvas "Budgets &
 * spending"): an empty field uses the workspace default. Saved on Enter or when the field loses
 * focus; owners only (the API checks the same). Values 0–1000 USD with at most two decimals.
 */
export function OverrideTable(props: {
  readonly rows: readonly OverrideRow[];
  readonly workspaceUsd: string;
}) {
  const t = useT();
  return (
    <div className="table-box">
      <table className="table" aria-label={t('set.projectOverrides')}>
        <thead>
          <tr>
            <th scope="col">{t('set.colProject')}</th>
            <th scope="col">{t('set.colConfirmAbove')}</th>
            <th scope="col">{t('set.colMonthly')}</th>
            <th scope="col">{t('set.colEffective')}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <Row key={row.projectId} row={row} workspaceUsd={props.workspaceUsd} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ row, workspaceUsd }: { readonly row: OverrideRow; readonly workspaceUsd: string }) {
  const t = useT();
  const router = useRouter();
  const saved = row.overrideUsd === null ? '' : String(Number(row.overrideUsd));
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const v = value.trim().replace(/,/g, '');
    if (v === saved) {
      setError(null);
      return;
    }
    if (v !== '' && !validThreshold(v)) {
      setError(t('set.thresholdInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await mutate('PUT', `/projects/${row.projectId}/budget`, {
      confirmThresholdUsd: v === '' ? null : v,
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(t('set.overrideSaved', { project: row.name }));
    router.refresh();
  }

  const effective = row.overrideUsd ?? workspaceUsd;
  return (
    <tr className={error ? 'row-error' : undefined}>
      <td>
        <span className="row">
          <span
            className="sw"
            style={{ background: projectSwatch(row.projectId) }}
            aria-hidden="true"
          />
          <b>{row.name}</b>
        </span>
      </td>
      <td>
        {row.canEdit ? (
          <div className="col override-cell">
            <span className={error ? 'input money error' : 'input money'}>
              <span aria-hidden="true">$</span>
              <input
                inputMode="decimal"
                value={value}
                placeholder={t('set.default')}
                disabled={busy}
                aria-label={t('set.confirmAboveFor', { project: row.name })}
                aria-invalid={error !== null}
                onChange={(e) => {
                  setValue(e.target.value);
                }}
                onBlur={() => void save()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </span>
            {error && (
              <span className="err-text" role="alert">
                <Icon name="warning" size={13} />
                {error}
              </span>
            )}
          </div>
        ) : (
          <span className="t-13 muted">{row.overrideUsd ? formatUsd(row.overrideUsd) : '—'}</span>
        )}
      </td>
      <td className="num">
        {row.monthlyLimitUsd ? formatUsd(row.monthlyLimitUsd) : t('set.noLimit')}
      </td>
      <td>
        {row.overrideUsd === null ? (
          <span className="t-13">
            {t('set.workspaceDefault', { amount: formatUsd(workspaceUsd) })}{' '}
            <span className="muted">· {t('set.inherited')}</span>
          </span>
        ) : (
          <span className="row t-13">
            {t('set.override', { amount: formatUsd(effective) })}
            <span className="badge accent">{t('set.overrideBadge')}</span>
          </span>
        )}
      </td>
    </tr>
  );
}
