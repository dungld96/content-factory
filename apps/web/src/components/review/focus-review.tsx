'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

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
}) {
  const t = useT();
  const [requested, setOpen] = useState(false);
  // Deciding ends the review: once nothing waits, the page returns to the workspace.
  const open = requested && props.reviewable;

  useEffect(() => {
    if (props.reviewable && window.location.hash.includes('focus')) setOpen(true);
  }, [props.reviewable]);

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
      <div className="focus-body">
        <div className="focus-main">{props.main}</div>
        <aside className="col focus-side">{props.side}</aside>
      </div>
    </div>
  );
}
