'use client';

import { useLocale, useT } from '@/components/i18n-provider';
import { Pill } from '@/components/status-pill';
import type { Tone } from '@/lib/content-status';
import { JOB_ERROR_GROUP_LABEL, jobError, type JobErrorGroup } from '@/lib/job-errors';

const GROUP_TONE: Readonly<Record<JobErrorGroup, Tone>> = {
  retry: 'gray',
  input: 'purple',
  operator: 'red',
  charged: 'amber',
};

/** A failed job's error: readable text, what to do (P3 W3), and the code for operators. */
export function JobErrorLine(props: {
  readonly code: string;
  readonly message?: string | null | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  const info = jobError(props.code, locale);
  return (
    <>
      {info.text}{' '}
      {info.group && (
        <Pill tone={GROUP_TONE[info.group]}>{t(JOB_ERROR_GROUP_LABEL[info.group])}</Pill>
      )}
      <div className="muted small-text">
        <code>{props.code}</code>
        {props.message ? ` · ${props.message}` : ''}
      </div>
    </>
  );
}
