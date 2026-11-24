'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import type { BudgetDto, UpdateBudgetRequest } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import type { MessageKey } from '@/lib/i18n';
import { formatUsd } from '@/lib/money';

import { validThreshold } from '../../../settings/spending-form';

const SCOPES: readonly {
  readonly key: 'monthly' | 'item' | 'request';
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly optional: boolean;
}[] = [
  { key: 'monthly', label: 'be.monthly', hint: 'be.monthlyHint', optional: false },
  { key: 'item', label: 'be.item', hint: 'be.itemHint', optional: true },
  { key: 'request', label: 'be.request', hint: 'be.requestHint', optional: true },
];
type ScopeKey = (typeof SCOPES)[number]['key'];

const USD = /^\d+(\.\d{1,6})?$/;

/**
 * Owner-only budget editor (M7 design §3, B1/B2): each limit is `hard` (blocks the request) or
 * `soft` (asks for confirmation; accepting is recorded). An empty optional limit means none.
 * Redesign R-D4: the project's cost-confirmation threshold (empty uses the workspace's).
 */
export function BudgetEditor({ budget }: { readonly budget: BudgetDto }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: ScopeKey) => {
      const limit = form.get(`${key}-limit`);
      return {
        raw: typeof limit === 'string' ? limit.trim() : '',
        mode: form.get(`${key}-mode`) === 'soft' ? ('soft' as const) : ('hard' as const),
      };
    };
    for (const scope of SCOPES) {
      const { raw } = read(scope.key);
      if (raw === '' && !scope.optional) {
        setError(t('be.monthlyRequired'));
        return;
      }
      if (raw !== '' && !USD.test(raw)) {
        setError(t('be.invalid', { scope: t(scope.label) }));
        return;
      }
    }
    const thresholdValue = form.get('threshold');
    const threshold = typeof thresholdValue === 'string' ? thresholdValue.trim() : '';
    if (threshold !== '' && !validThreshold(threshold)) {
      setError(t('set.thresholdInvalid'));
      return;
    }
    const optional = (key: 'item' | 'request') => {
      const { raw, mode } = read(key);
      return { limitUsd: raw === '' ? null : raw, mode };
    };
    const request: UpdateBudgetRequest = {
      monthly: { limitUsd: read('monthly').raw, mode: read('monthly').mode },
      item: optional('item'),
      request: optional('request'),
      confirmThresholdUsd: threshold === '' ? null : threshold,
    };
    setBusy(true);
    setError(null);
    const r = await mutate<BudgetDto>('PUT', `/projects/${budget.projectId}/budget`, request);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? t('form.requestFailed', { status: r.status }));
      return;
    }
    toast(t('be.saved'));
    router.refresh();
  }

  const current = (key: ScopeKey) => budget[key];
  const workspaceDefault =
    budget.confirmThresholdUsd === null ? budget.effectiveConfirmThresholdUsd : null;
  return (
    <form
      id="budget-limits"
      className="card card-pad budget-editor"
      aria-label={t('be.title')}
      onSubmit={(e) => void submit(e)}
    >
      <h2>{t('be.title')}</h2>
      <p className="muted small-text">{t('be.hint')}</p>
      {SCOPES.map((scope) => (
        <div className="form-row" key={scope.key}>
          <div className="field">
            <label htmlFor={`${scope.key}-limit`}>{t('be.limit', { scope: t(scope.label) })}</label>
            <input
              id={`${scope.key}-limit`}
              name={`${scope.key}-limit`}
              inputMode="decimal"
              defaultValue={current(scope.key).limitUsd ?? ''}
              placeholder={scope.optional ? t('be.noLimit') : undefined}
              aria-describedby={`${scope.key}-hint`}
            />
            <span id={`${scope.key}-hint`} className="muted small-text">
              {t(scope.hint)}
            </span>
          </div>
          <div className="field">
            <label htmlFor={`${scope.key}-mode`}>{t('be.mode', { scope: t(scope.label) })}</label>
            <select
              id={`${scope.key}-mode`}
              name={`${scope.key}-mode`}
              defaultValue={current(scope.key).mode}
            >
              <option value="hard">{t('be.hard')}</option>
              <option value="soft">{t('be.soft')}</option>
            </select>
          </div>
        </div>
      ))}
      <div className="field">
        <label htmlFor="threshold">{t('be.threshold')}</label>
        <input
          id="threshold"
          name="threshold"
          inputMode="decimal"
          defaultValue={budget.confirmThresholdUsd ?? ''}
          placeholder={t('be.thresholdPlaceholder')}
          aria-describedby="threshold-hint"
        />
        <span id="threshold-hint" className="muted small-text">
          {t('be.thresholdHint', {
            amount: formatUsd(workspaceDefault ?? budget.effectiveConfirmThresholdUsd),
          })}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {t('be.save')}
        </button>
      </div>
    </form>
  );
}
