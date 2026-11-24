'use client';

import { useCallback, useEffect, useState } from 'react';

import type { GenerationJobDetailDto, GenerationJobDto, Page } from '@acf/contracts';

import { CancelRunButton } from '@/components/cancel-run';
import { useT } from '@/components/i18n-provider';
import { DeliveredOutputActions } from '@/components/delivered-output';
import { JobErrorLine } from '@/components/job-error';
import { LocalTime, RelativeTime } from '@/components/local-time';
import { ResumeRunButton } from '@/components/resume-run';
import { Pill } from '@/components/status-pill';
import { fetchJson } from '@/lib/api-client';
import type { Tone } from '@/lib/content-status';
import { jobKindLabel } from '@/lib/format';
import { onJobEvent } from '@/lib/live/store';
import { addUsd, formatUsd } from '@/lib/money';

const ACTIVE = new Set(['queued', 'running']);
const STATUS_TONE: Readonly<Record<GenerationJobDto['status'], Tone>> = {
  queued: 'gray',
  running: 'purple',
  succeeded: 'green',
  failed: 'red',
  canceled: 'gray',
};
const PAGE_SIZE = 20;

function fetchJobs(
  contentId: string,
  failedOnly: boolean,
  after: string | null,
): Promise<Page<GenerationJobDto> | null> {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (failedOnly) query.set('status', 'failed');
  if (after) query.set('cursor', after);
  return fetchJson<Page<GenerationJobDto>>(`/content/${contentId}/jobs?${query.toString()}`);
}

/**
 * The content item's jobs, newest first (P3 design W4): one compact row per job, expandable to
 * its event history. Reloads when one of the item's jobs changes state (live store, R-D5).
 */
export function JobActivity(props: {
  readonly contentId: string;
  /** Scene numbers by storyboard scene id (the approved storyboard's scenes). */
  readonly sceneNumbers: Readonly<Record<string, number>>;
  readonly canEdit: boolean;
}) {
  const t = useT();
  const [failedOnly, setFailedOnly] = useState(false);
  const [jobs, setJobs] = useState<GenerationJobDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const apply = useCallback((page: Page<GenerationJobDto> | null, append: boolean) => {
    if (!page) {
      setError(true);
      return;
    }
    setError(false);
    setJobs((prev) => (append && prev ? [...prev, ...page.data] : page.data));
    setCursor(page.page.nextCursor);
  }, []);

  useEffect(() => {
    let live = true;
    void fetchJobs(props.contentId, failedOnly, null).then((page) => {
      if (live) apply(page, false);
    });
    return () => {
      live = false;
    };
  }, [props.contentId, failedOnly, apply]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onJobEvent((e) => {
      if (e.contentItemId !== props.contentId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void fetchJobs(props.contentId, failedOnly, null).then((page) => {
          apply(page, false);
        });
      }, 400);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [props.contentId, failedOnly, apply]);

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-head">
        <div>
          <h3>{t('ja.title')}</h3>
          <p>{t('ja.hint')}</p>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => {
              setFailedOnly(e.target.checked);
            }}
          />{' '}
          {t('ja.failedOnly')}
        </label>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {t('ja.loadError')}
        </p>
      )}
      {jobs === null ? (
        <p className="muted small-text" aria-busy="true">
          {t('common.loading')}
        </p>
      ) : jobs.length === 0 ? (
        <div className="empty">{failedOnly ? t('ja.noFailed') : t('ja.none')}</div>
      ) : (
        <ul className="plain-list" aria-label={t('ja.list')}>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              sceneNumber={
                job.storyboardSceneId ? props.sceneNumbers[job.storyboardSceneId] : undefined
              }
              canEdit={props.canEdit}
            />
          ))}
        </ul>
      )}
      {cursor && (
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            void fetchJobs(props.contentId, failedOnly, cursor).then((page) => {
              apply(page, true);
            })
          }
        >
          {t('ja.older')}
        </button>
      )}
    </div>
  );
}

function JobRow(props: {
  readonly job: GenerationJobDto;
  readonly sceneNumber: number | undefined;
  readonly canEdit: boolean;
}) {
  const t = useT();
  const { job } = props;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<GenerationJobDetailDto | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchJson<GenerationJobDetailDto>(`/generation-jobs/${job.id}`).then((d) => {
      if (live) setDetail(d);
    });
    return () => {
      live = false;
    };
  }, [open, job.id, job.status, job.attempt]);

  const stage = `${jobKindLabel(t, job.kind)}${
    props.sceneNumber === undefined ? '' : ` ${t('ja.scene', { number: props.sceneNumber })}`
  }`;
  const cost = addUsd(job.cost.reportedUsd, job.cost.estimatedUsd);
  return (
    <li className="job-row">
      <details
        open={open}
        onToggle={(e) => {
          setOpen(e.currentTarget.open);
        }}
      >
        <summary>
          <b>{stage}</b> <Pill tone={STATUS_TONE[job.status]}>{t(`state.${job.status}`)}</Pill>{' '}
          <span className="muted small-text">
            {t('ja.meta', {
              attempt: job.attempt,
              max: job.maxAttempts,
              model: job.modelKey,
              cost: formatUsd(cost),
            })}
            {job.cost.unknownCalls > 0
              ? ` ${t('ja.unknown', { count: job.cost.unknownCalls })}`
              : ''}{' '}
            · <RelativeTime iso={job.queuedAt} />
          </span>
        </summary>
        {job.errorCode && (
          <div className="small-text" style={{ marginTop: 6 }}>
            <JobErrorLine code={job.errorCode} message={job.errorMessage} />
          </div>
        )}
        {detail === null ? (
          <p className="muted small-text" aria-busy="true">
            {t('ja.loadingEvents')}
          </p>
        ) : (
          <ol className="small-text" aria-label={t('ja.eventsOf', { stage })}>
            {detail.events.map((e, i) => (
              <li key={`${e.createdAt}-${String(i)}`}>
                <LocalTime iso={e.createdAt} /> · {e.type} ·{' '}
                {e.fromStatus ? `${e.fromStatus} → ` : ''}
                {e.toStatus} {t('ja.eventAttempt', { count: e.attempt })}
                {e.errorCode ? ` · ${e.errorCode}` : ''}
              </li>
            ))}
          </ol>
        )}
      </details>
      <DeliveredOutputActions job={job} canEdit={props.canEdit} />
      {props.canEdit &&
        !job.finishable &&
        (job.status === 'failed' || job.status === 'canceled') && (
          <ResumeRunButton runId={job.productionRunId} />
        )}
      {props.canEdit && ACTIVE.has(job.status) && (
        <CancelRunButton
          runId={job.productionRunId}
          what={t('ja.batch')}
          video={job.kind === 'video_generation'}
        />
      )}
    </li>
  );
}
