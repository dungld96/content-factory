'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { RelativeTime } from '@/components/local-time';
import { StatusBadge } from '@/components/status-badge';
import { toast } from '@/components/toast';
import { jobKindLabel } from '@/lib/format';
import { useLive } from '@/lib/live/hooks';
import { onJobEvent, startLive } from '@/lib/live/store';

/**
 * The top bar's Jobs tray (redesign R5): running and queued jobs of the user's projects from
 * the one live store, jobs that finished while the page was open, and a toast when a job of
 * another page ends. `aria-live` announces changes politely.
 */
export function JobsTray() {
  const t = useT();
  const path = usePathname();
  const live = useLive();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startLive();
  }, []);

  useEffect(
    () =>
      onJobEvent((e) => {
        if (e.to !== 'succeeded' && e.to !== 'failed' && e.to !== 'canceled') return;
        if (document.visibilityState !== 'visible') return;
        if (path.startsWith(`/content/${e.contentItemId}`)) return;
        toast(t(`jobs.toast.${e.to}`, { kind: jobKindLabel(t, e.kind), title: e.contentTitle }));
      }),
    [path, t],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const running = live.active.filter((j) => j.status === 'running');
  const queued = live.active.filter((j) => j.status === 'queued');
  const label = t('jobs.buttonLabel', { running: running.length, queued: queued.length });

  return (
    <div className="jobs-tray" ref={panel}>
      <button
        type="button"
        className={live.active.length > 0 ? 'jobs-pill busy' : 'jobs-pill'}
        aria-expanded={open}
        aria-controls="jobs-panel"
        aria-label={label}
        title={label}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span className={running.length > 0 ? 'dot pulse' : 'dot'} aria-hidden="true" />
        <span className="jobs-word">{t('jobs.pill', { count: running.length })}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
      {open && (
        <div id="jobs-panel" className="jobs-panel card" role="dialog" aria-label={t('jobs.title')}>
          <div className="jobs-panel-head">
            <b>{t('jobs.title')}</b>
            <span className={`transport ${live.transport}`}>
              {t(`jobs.transport.${live.transport}`)}
            </span>
          </div>
          {live.active.length === 0 ? (
            <p className="muted small-text">{t('jobs.none')}</p>
          ) : (
            <ul className="jobs-list">
              {[...running, ...queued].map((j) => (
                <li key={j.jobId}>
                  <Link
                    href={`/content/${j.contentItemId}`}
                    onClick={() => {
                      setOpen(false);
                    }}
                  >
                    <b>{j.contentTitle}</b>
                    <span className="subline">
                      {jobKindLabel(t, j.kind)}
                      {j.sceneNumber !== null
                        ? ` · ${t('jobs.scene', { number: j.sceneNumber })}`
                        : ''}
                      {j.attempt > 1 ? ` · ${t('jobs.attempt', { count: j.attempt })}` : ''}
                    </span>
                  </Link>
                  <StatusBadge state={j.status === 'running' ? 'running' : 'queued'} />
                </li>
              ))}
            </ul>
          )}
          {live.finished.length > 0 && (
            <>
              <div className="jobs-sub">{t('jobs.recent')}</div>
              <ul className="jobs-list">
                {live.finished.slice(0, 5).map((f) => (
                  <li key={f.jobId}>
                    <Link
                      href={`/content/${f.contentItemId}`}
                      onClick={() => {
                        setOpen(false);
                      }}
                    >
                      <b>{f.contentTitle}</b>
                      <span className="subline">
                        {jobKindLabel(t, f.kind)} · <RelativeTime iso={f.at} />
                      </span>
                    </Link>
                    <StatusBadge state={f.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link
            className="link small-text"
            href="/operations"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('jobs.operations')}
          </Link>
        </div>
      )}
    </div>
  );
}
