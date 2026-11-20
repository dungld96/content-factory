'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import type { ResumeRunResponseDto } from '@acf/contracts';

import { Modal } from '@/components/modal';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { MAX_RESUME_ROUNDS, nextResumeStep, type ResumeBody } from '@/lib/resume-flow';

const SKIP_TEXT: Readonly<Record<ResumeRunResponseDto['skipped'][number]['reason'], string>> = {
  outcome_unknown: 'possibly charged already',
  superseded: 'already redone',
  in_progress: 'running again',
};

interface Question {
  readonly title: string;
  readonly text: string;
  readonly answer: (yes: boolean) => void;
}

/**
 * Resume of a production run with failures (M7 design §6, P3 W1): the failed stages are
 * requested again in a new run, with the usual budget checks. When the API asks for a consent
 * (the clip estimate, unknown cost, a possible double charge) the dialog shows what it is and
 * the request is sent again with it.
 */
export function ResumeRunButton(props: { readonly runId: string; readonly label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const answered = useRef(false);

  const ask = (title: string, text: string) =>
    new Promise<boolean>((resolve) => {
      answered.current = false;
      setQuestion({
        title,
        text,
        answer: (yes) => {
          if (answered.current) return;
          answered.current = true;
          setQuestion(null);
          resolve(yes);
        },
      });
    });

  async function resume() {
    setBusy(true);
    setError(null);
    let body: ResumeBody = {};
    for (let round = 0; round <= MAX_RESUME_ROUNDS; round += 1) {
      const r = await mutate<ResumeRunResponseDto>(
        'POST',
        `/production-runs/${props.runId}/resume`,
        body,
      );
      if (r.ok && r.data) {
        setBusy(false);
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
        return;
      }
      const step = nextResumeStep(r, body);
      if (step.kind === 'error' || round === MAX_RESUME_ROUNDS) {
        setBusy(false);
        setError(
          step.kind === 'error' ? step.text : (r.message ?? 'The run could not be resumed.'),
        );
        return;
      }
      if (!(await ask(step.title, step.text))) {
        setBusy(false);
        return;
      }
      body = step.next;
    }
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
      <Modal
        open={question !== null}
        onClose={() => question?.answer(false)}
        title={question?.title ?? ''}
        description={question?.text}
      >
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => question?.answer(false)}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => question?.answer(true)}>
            Resume
          </button>
        </div>
      </Modal>
    </>
  );
}
