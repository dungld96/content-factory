'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { GenerationJobDto } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';

const ACTIVE = new Set(['queued', 'running']);

/**
 * Cancels a production run's queued and running work (P3 design W2; `POST
 * /production-runs/:runId/cancel`). A clip already submitted keeps running at the provider and
 * may still be charged, so the dialog says so for video batches.
 */
export function CancelRunButton(props: {
  readonly runId: string;
  /** What is canceled, e.g. "this batch: 4 scenes". */
  readonly what: string;
  readonly video?: boolean | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const r = await mutate('POST', `/production-runs/${props.runId}/cancel`, {});
    setBusy(false);
    setOpen(false);
    if (!r.ok) {
      setError(r.code === 'NOT_CANCELABLE' ? 'Nothing is running any more.' : errorText(r));
      router.refresh();
      return;
    }
    toast('Canceled.');
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="cancel" /> Cancel
      </button>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={`Cancel ${props.what}?`}
        description={
          props.video
            ? 'Queued clips are not sent. A clip already submitted keeps running at the provider and may still be charged.'
            : 'Queued work is not started. A call already running finishes, and its result is discarded.'
        }
      >
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOpen(false);
            }}
          >
            Keep running
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy ? 'Canceling…' : 'Cancel it'}
          </button>
        </div>
      </Modal>
    </>
  );
}

/** One Cancel button per run with active jobs among these scene jobs (scene tabs). */
export function CancelActiveRuns(props: {
  readonly jobs: readonly (GenerationJobDto | null | undefined)[];
  readonly video?: boolean | undefined;
}) {
  const runs = new Map<string, number>();
  for (const job of props.jobs) {
    if (job && ACTIVE.has(job.status)) {
      runs.set(job.productionRunId, (runs.get(job.productionRunId) ?? 0) + 1);
    }
  }
  return [...runs].map(([runId, scenes]) => (
    <CancelRunButton
      key={runId}
      runId={runId}
      what={`this batch (${String(scenes)} scene${scenes === 1 ? '' : 's'})`}
      video={props.video}
    />
  ));
}
