'use client';

import { useT } from '@/components/i18n-provider';

export default function ErrorBoundary({
  reset,
}: {
  readonly error: Error;
  readonly reset: () => void;
}) {
  const t = useT();
  return (
    <section className="card card-pad" role="alert">
      <h2>{t('app.errorTitle')}</h2>
      <p className="muted">{t('app.errorBody')}</p>
      <button type="button" className="btn primary" onClick={reset}>
        {t('common.retry')}
      </button>
    </section>
  );
}
