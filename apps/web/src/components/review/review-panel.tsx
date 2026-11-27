'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';

import { ReviewChecklist, useChecklist, type CheckItem } from './review-checklist';

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'TEXTAREA' ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable);

/**
 * Review mode decision panel for gates 1 and 2 (redesign R4): checklist, Approve, and Request
 * changes with a required note (sent with the rejection and kept on the version). Single-key
 * shortcuts work while focus is inside the panel and not in a text field: A approve, R request
 * changes, C check all.
 */
export function ReviewPanel(props: {
  readonly kind: 'scripts' | 'storyboards';
  readonly id: string;
  /** "script", "storyboard v3", already translated. */
  readonly what: string;
  readonly gate: string;
  readonly items: readonly CheckItem[];
}) {
  const t = useT();
  const router = useRouter();
  const checklist = useChecklist(`acf-review:${props.kind}:${props.id}`, props.items);
  const [mode, setMode] = useState<'idle' | 'changes'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  async function decide(action: 'approve' | 'reject') {
    if (action === 'reject' && !note.trim()) {
      setError(t('review.noteRequired'));
      noteRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const r = await mutate(
      'POST',
      `/${props.kind}/${props.id}/${action}`,
      action === 'reject' ? { note: note.trim() } : {},
    );
    setBusy(false);
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    toast(
      action === 'approve'
        ? t('review.approved', { what: props.what })
        : t('review.rejected', { what: props.what }),
    );
    router.refresh();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      void decide('approve');
    } else if (key === 'r') {
      event.preventDefault();
      setMode('changes');
      setTimeout(() => noteRef.current?.focus(), 0);
    } else if (key === 'c') {
      event.preventDefault();
      checklist.checkAll();
    }
  }

  const done = props.items.filter((i) => checklist.checked.has(i.id)).length;
  return (
    <section
      className="review-panel col"
      aria-label={t('review.decision')}
      onKeyDown={onKeyDown}
      // Focusable so the shortcuts work after a click anywhere in the panel.
      tabIndex={-1}
    >
      <div className="card check-card">
        <div className="card-head">
          <h3>{t('review.before')}</h3>
          <span className="badge review">
            {t('review.doneOf', { done, total: props.items.length })}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm"
            onClick={checklist.checkAll}
            disabled={done === props.items.length}
            aria-keyshortcuts="C"
          >
            <Icon name="check" /> {t('review.checkAll')} <kbd aria-hidden="true">C</kbd>
          </button>
        </div>
        <div className="card-body col">
          <span className="eyebrow">{props.gate}</span>
          <ReviewChecklist items={props.items} state={checklist} />
          <p className="t-12 muted">{t('review.keys')}</p>
        </div>
      </div>
      <div className="card decision-card">
        <div className="card-head">
          <h3>{t('review.decision')}</h3>
        </div>
        <div className="card-body col">
          <label className="field">
            {t('review.noteLabel')}
            <span className="hint">{t('review.noteHint')}</span>
            <textarea
              ref={noteRef}
              className="input"
              rows={3}
              maxLength={2000}
              value={note}
              placeholder={t('review.notePlaceholder')}
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="btn primary lg"
            disabled={busy}
            aria-keyshortcuts="A"
            onClick={() => void decide('approve')}
          >
            <Icon name="check" /> {t('review.approve', { what: props.what })}{' '}
            <kbd aria-hidden="true">A</kbd>
          </button>
          {checklist.unchecked > 0 && (
            <p className="t-12 muted">
              {t('review.uncheckedHint', { count: checklist.unchecked })}
            </p>
          )}
          <button
            type="button"
            className="btn lg"
            disabled={busy}
            aria-keyshortcuts="R"
            onClick={() => {
              if (mode === 'changes' || note.trim()) {
                void decide('reject');
              } else {
                setMode('changes');
                setError(t('review.noteRequired'));
                setTimeout(() => noteRef.current?.focus(), 0);
              }
            }}
          >
            <Icon name="message" /> {t('review.requestChanges')} <kbd aria-hidden="true">R</kbd>
          </button>
          {error && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
          <p className="t-12 muted">{t('review.afterApprove')}</p>
        </div>
      </div>
    </section>
  );
}
