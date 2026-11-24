'use client';

import { useT } from '@/components/i18n-provider';
import { diffWords, hasChanges } from '@/lib/text-diff';

/** What changed in a text since the previous version (redesign R4). */
export function TextDiff(props: {
  readonly before: string;
  readonly after: string;
  readonly version: number;
}) {
  const t = useT();
  const parts = diffWords(props.before, props.after);
  if (!hasChanges(parts)) {
    return <p className="muted small-text">{t('review.noDiff', { version: props.version })}</p>;
  }
  return (
    <details className="text-diff">
      <summary>{t('review.diff', { version: props.version })}</summary>
      <p>
        {parts.map((p, i) =>
          p.kind === 'same' ? (
            <span key={i}>{p.text}</span>
          ) : p.kind === 'added' ? (
            <ins key={i} title={t('review.added')}>
              {p.text}
            </ins>
          ) : (
            <del key={i} title={t('review.removed')}>
              {p.text}
            </del>
          ),
        )}
      </p>
    </details>
  );
}
