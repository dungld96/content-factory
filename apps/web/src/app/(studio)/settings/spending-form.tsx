'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import { useT } from '@/components/i18n-provider';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';

/** 0–1000 USD with at most two decimals (the API checks the same, R-D4). */
export const THRESHOLD = /^\d{1,4}(\.\d{1,2})?$/;
export const validThreshold = (v: string) => THRESHOLD.test(v) && Number(v) <= 1000;

/** The workspace cost-confirmation threshold (redesign R-D4); operators only. */
export function SpendingForm(props: { readonly thresholdUsd: string; readonly canEdit: boolean }) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState(props.thresholdUsd);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = value.trim();
    if (!validThreshold(v)) {
      setError(t('set.thresholdInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await mutate('PUT', '/settings/spending', { confirmThresholdUsd: v });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(t('set.thresholdSaved'));
    router.refresh();
  }

  return (
    <form className="form" aria-label={t('set.threshold')} onSubmit={(e) => void save(e)}>
      <label className="field">
        {t('set.workspaceThreshold')}
        <span className="input-prefix">
          <span aria-hidden="true">$</span>
          <input
            inputMode="decimal"
            value={value}
            disabled={!props.canEdit || busy}
            aria-invalid={error !== null}
            aria-describedby="threshold-hint"
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </span>
      </label>
      <p id="threshold-hint" className="muted small-text">
        {props.canEdit ? t('set.thresholdInvalid') : t('set.thresholdOperators')}
      </p>
      <label className="checkbox">
        <input type="checkbox" checked disabled readOnly /> {t('set.unknownAlways')}
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {props.canEdit && (
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      )}
    </form>
  );
}
