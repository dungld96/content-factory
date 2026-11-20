'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: 'settle' | 'release') {
    const question =
      action === 'settle'
        ? `Record ${props.label} as charged by the provider? It stays counted as spent.`
        : `Record ${props.label} as not charged? It stops counting against the budget.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    const r = await mutate('POST', `/ops/reservations/${props.reservationId}/${action}`, {});
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
      return;
    }
    toast(action === 'settle' ? 'Recorded as charged.' : 'Recorded as not charged.');
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
        Charged
      </button>
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => void resolve('release')}
      >
        Not charged
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
