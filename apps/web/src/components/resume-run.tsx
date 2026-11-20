'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ResumeRunResponseDto } from '@acf/contracts';

import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';

const SKIP_TEXT: Readonly<Record<ResumeRunResponseDto['skipped'][number]['reason'], string>> = {
  outcome_unknown: 'possibly charged already',
  superseded: 'already redone',
  in_progress: 'running again',
};

/**
 * Resume of a production run with failures (M7 design §6): the failed stages are requested again
 * in a new run, with the usual budget checks. A job whose submission may already have been
 * charged is resumed only after an explicit confirmation.
 */
export function ResumeRunButton(props: { readonly runId: string; readonly label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume(acceptPossibleDoubleCharge = false) {
    setBusy(true);
    setError(null);
    const r = await mutate<ResumeRunResponseDto>(
      'POST',
      `/production-runs/${props.runId}/resume`,
      acceptPossibleDoubleCharge ? { acceptPossibleDoubleCharge: true } : {},
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      if (
        r.code === 'NOTHING_TO_RESUME' &&
        !acceptPossibleDoubleCharge &&
        r.message?.includes('acceptPossibleDoubleCharge') &&
        window.confirm(
          'Some jobs ended without knowing whether the provider accepted them. Resuming them may be charged twice. Resume anyway?',
        )
      ) {
        await resume(true);
        return;
      }
      setError(
        r.code === 'NOTHING_TO_RESUME'
          ? 'Nothing to resume: the failed work was already redone or is running again.'
          : (r.message ?? `Request failed (HTTP ${String(r.status)})`),
      );
      return;
    }
    const queued = r.data.run?.jobs.length ?? 0;
    const skipped = r.data.skipped.map((s) => SKIP_TEXT[s.reason]);
    toast(
      `${queued > 0 ? `Resumed: ${String(queued)} job(s) queued.` : 'Nothing needed generating again.'}${
        skipped.length > 0
          ? ` Skipped ${String(skipped.length)} (${[...new Set(skipped)].join(', ')}).`
          : ''
      }`,
    );
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void resume()}>
        <span aria-hidden="true">↻</span> {props.label ?? 'Resume'}
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
