'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { ActiveJobDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon, type IconName } from '@/components/icon';
import { jobKindLabel } from '@/lib/format';
import { useLive } from '@/lib/live/hooks';
import { startLive } from '@/lib/live/store';

const KIND_ICON: Readonly<Record<string, IconName>> = {
  script_generation: 'edit',
  storyboard_generation: 'board',
  image_generation: 'image',
  video_generation: 'film',
  tts_generation: 'mic',
  render: 'render',
};

/** "1:12": minutes and seconds since `iso`. */
function elapsed(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Running now (redesign canvas, To-do): the user's queued and running jobs from the one live
 * store (SSE, ADR-0022), with the time since each started. A retried job shows its attempt.
 */
export function RunningNow() {
  const t = useT();
  const live = useLive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    startLive();
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  const jobs: readonly ActiveJobDto[] = [
    ...live.active.filter((j) => j.status === 'running'),
    ...live.active.filter((j) => j.status === 'queued'),
  ].slice(0, 6);
  return (
    <section className="card" aria-labelledby="running-heading">
      <div className="card-head">
        <h3 id="running-heading">{t('todo.running')}</h3>
        <span className="spacer" />
        <span className="t-12 muted">{t(`jobs.transport.${live.transport}`)}</span>
      </div>
      <div className="card-body col running-list" aria-live="polite">
        {jobs.length === 0 ? (
          <p className="muted t-13">{t('todo.runningEmpty')}</p>
        ) : (
          jobs.map((j) => (
            <Link key={j.jobId} className="col running-job" href={`/content/${j.contentItemId}`}>
              <span className="row t-13">
                <Icon name={KIND_ICON[j.kind] ?? 'operations'} />
                <b>
                  {j.sceneNumber !== null ? `${t('jobs.scene', { number: j.sceneNumber })} · ` : ''}
                  {jobKindLabel(t, j.kind)}
                </b>
                <span className="spacer" />
                {j.attempt > 1 ? (
                  <span className="badge info outline">
                    {t('todo.retry', { attempt: j.attempt })}
                  </span>
                ) : (
                  <span className="num muted">
                    {j.status === 'running' ? elapsed(j.updatedAt, now) : t('jobs.queued')}
                  </span>
                )}
              </span>
              <span className="t-12 muted">{j.contentTitle}</span>
              {j.status === 'running' && (
                <span className="meter thin indeterminate" aria-hidden="true">
                  <i className="run" />
                </span>
              )}
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
