'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

/**
 * Focus review (redesign canvas "Gate 1 · Script review"): the version under review on the left,
 * the checklist, brief and decision on the right. Inline it is a two-column card; "Focus review"
 * (or a link with `focus` in the hash, e.g. from To-do) opens the same content full screen with a
 * header, and Escape closes it.
 */
export function FocusReview(props: {
  /** "Gate 1 of 4". */
  readonly gate: string;
  /** "Script review". */
  readonly title: string;
  readonly subtitle: string;
  /** Offer focus mode (a version is waiting for review). */
  readonly reviewable: boolean;
  readonly main: ReactNode;
  readonly side: ReactNode;
  /** The previous version, read-only, for the v1/v2 switch; omitted for a first version. */
  readonly previous?:
    { readonly label: string; readonly current: string; readonly main: ReactNode } | undefined;
  /** Position among the To-do decisions, with the neighbours' links. */
  readonly queue?:
    | {
        readonly index: number;
        readonly total: number;
        readonly prev: string | null;
        readonly next: string | null;
      }
    | undefined;
}) {
  const t = useT();
  // null: follow the link (`focus` in the hash); true/false: the reviewer opened or closed it.
  const [requested, setOpen] = useState<boolean | null>(null);
  const fromLink = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash.includes('focus'),
    () => false,
  );
  // Deciding ends the review: once nothing waits, the page returns to the workspace.
  const open = (requested ?? fromLink) && props.reviewable;
  const [showPrevious, setShowPrevious] = useState(false);
  const [changes, setChanges] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // "Show changes": open every word diff of the version (they are folded by default).
  useEffect(() => {
    for (const d of body.current?.querySelectorAll('details.text-diff') ?? []) {
      (d as HTMLDetailsElement).open = changes;
    }
  }, [changes, showPrevious]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('focus-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('focus-open');
    };
  }, [open]);

  return (
    <div
      className={open ? 'focus-review open' : 'focus-review'}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? true : undefined}
      aria-label={open ? props.title : undefined}
    >
      {open ? (
        <header className="focus-head">
          <button
            type="button"
            className="btn icon ghost"
            aria-label={t('review.focusClose')}
            onClick={() => {
              setOpen(false);
            }}
          >
            <Icon name="cancel" size={20} />
          </button>
          <div className="col focus-title">
            <span className="row">
              <span className="badge review">
                <Icon name="shield" size={13} />
                {props.gate}
              </span>
              <b>{props.title}</b>
            </span>
            <span className="t-12 muted">{props.subtitle}</span>
          </div>
          <span className="spacer" />
          {props.previous && (
            <>
              <div className="seg" role="group" aria-label={t('review.versions')}>
                <button
                  type="button"
                  className={showPrevious ? 'on' : undefined}
                  aria-pressed={showPrevious}
                  onClick={() => {
                    setShowPrevious(true);
                  }}
                >
                  {props.previous.label}
                </button>
                <button
                  type="button"
                  className={showPrevious ? undefined : 'on'}
                  aria-pressed={!showPrevious}
                  onClick={() => {
                    setShowPrevious(false);
                  }}
                >
                  {t('review.latest', { version: props.previous.current })}
                </button>
              </div>
              <button
                type="button"
                className="btn sm"
                aria-pressed={changes}
                disabled={showPrevious}
                onClick={() => {
                  setChanges((v) => !v);
                }}
              >
                <Icon name="eye" />
                {changes
                  ? t('review.hideChanges')
                  : t('review.showChangesFrom', { version: props.previous.label })}
              </button>
            </>
          )}
          {props.queue && props.queue.total > 0 && (
            <nav className="row focus-queue" aria-label={t('review.queue')}>
              <span className="t-13 muted">
                {t('review.queuePos', { index: props.queue.index, total: props.queue.total })}
              </span>
              {props.queue.prev ? (
                <a className="btn sm icon" href={props.queue.prev} aria-label={t('review.prev')}>
                  <Icon name="chevronRight" className="flip" />
                </a>
              ) : (
                <span className="btn sm icon" aria-disabled="true">
                  <Icon name="chevronRight" className="flip" />
                </span>
              )}
              {props.queue.next ? (
                <a className="btn sm icon" href={props.queue.next} aria-label={t('review.next')}>
                  <Icon name="chevronRight" />
                </a>
              ) : (
                <span className="btn sm icon" aria-disabled="true">
                  <Icon name="chevronRight" />
                </span>
              )}
            </nav>
          )}
        </header>
      ) : (
        props.reviewable && (
          <div className="focus-bar">
            <span className="badge review">
              <Icon name="shield" size={13} />
              {props.gate}
            </span>
            <span className="t-13 muted">{t('review.focusHint')}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setOpen(true);
              }}
            >
              <Icon name="eye" />
              {t('review.focusOpen')}
            </button>
          </div>
        )
      )}
      <div className="focus-body" ref={body}>
        <div className={changes ? 'focus-main changes' : 'focus-main'}>
          {open && showPrevious && props.previous ? (
            <div className="col focus-previous" aria-label={props.previous.label}>
              <p className="callout info t-13">
                {t('review.previousNote', { version: props.previous.label })}
              </p>
              {props.previous.main}
            </div>
          ) : (
            props.main
          )}
        </div>
        <aside className="col focus-side">{props.side}</aside>
      </div>
    </div>
  );
}
