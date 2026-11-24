'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';

/**
 * Owner resolution of a held reservation (M7 design §4, §8): the provider's invoice or dashboard
 * tells whether the lost call was charged. Settled keeps the amount counted as spent.
 */
export function ReservationActions(props: {
  readonly reservationId: string;
  readonly label: string;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: 'settle' | 'release') {
    const question =
      action === 'settle'
        ? t('reservation.settleQ', { amount: props.label })
        : t('reservation.releaseQ', { amount: props.label });
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    const r = await mutate('POST', `/ops/reservations/${props.reservationId}/${action}`, {});
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? t('form.requestFailed', { status: r.status }));
      return;
    }
    toast(action === 'settle' ? t('reservation.settled') : t('reservation.released'));
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => void resolve('settle')}
      >
        {t('reservation.charged')}
      </button>
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => void resolve('release')}
      >
        {t('reservation.notCharged')}
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
