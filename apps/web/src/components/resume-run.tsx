'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import type { ResumeRunResponseDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';
import { MAX_RESUME_ROUNDS, nextResumeStep, type ResumeBody } from '@/lib/resume-flow';

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
export function ResumeRunButton(props: {
  readonly runId: string;
  readonly label?: string;
  readonly className?: string;
}) {
  const t = useT();
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
        const skipped = r.data.skipped.map((s) => t(`resume.skip.${s.reason}`));
        toast(
          `${queued > 0 ? t('resume.queued', { count: queued }) : t('resume.nothing')}${
            skipped.length > 0
              ? ` ${t('resume.skipped', { count: skipped.length, reasons: [...new Set(skipped)].join(', ') })}`
              : ''
          }`,
        );
        router.refresh();
        return;
      }
      const step = nextResumeStep(r, body, t);
      if (step.kind === 'error' || round === MAX_RESUME_ROUNDS) {
        setBusy(false);
        setError(step.kind === 'error' ? step.text : (r.message ?? t('resume.failed')));
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
      <button
        type="button"
        className={props.className ?? 'btn ghost'}
        disabled={busy}
        onClick={() => void resume()}
      >
        <Icon name="resume" /> {props.label ?? t('resume.button')}
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
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => question?.answer(true)}>
            {t('resume.button')}
          </button>
        </div>
      </Modal>
    </>
  );
}
