'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/modal';
import { toast } from '@/components/toast';
import { errorText, mutate, type MutationResult } from '@/lib/api-client';
import type { MessageKey } from '@/lib/i18n';

/** What can be archived from the studio; each kind has its own consequence text. */
export type ArchiveKind =
  'content' | 'master' | 'project' | 'character' | 'environment' | 'channel' | 'collection';

const CONSEQUENCE: Readonly<Record<ArchiveKind, MessageKey>> = {
  content: 'arc.body.content',
  master: 'arc.body.master',
  project: 'arc.body.project',
  character: 'arc.body.brand',
  environment: 'arc.body.brand',
  channel: 'arc.body.channel',
  collection: 'arc.body.collection',
};

/** API refusals that have a plain explanation (the API's own message is English). */
const REFUSAL: Readonly<Record<string, MessageKey>> = {
  CONTENT_HAS_ACTIVE_JOBS: 'arc.err.activeJobs',
  MASTER_HAS_ACTIVE_VARIANTS: 'arc.err.activeVariants',
  NAME_TAKEN: 'arc.err.nameTaken',
  ARCHIVED: 'arc.err.parentArchived',
  FORBIDDEN: 'arc.err.forbidden',
};

/**
 * Archive ("delete") and restore for one record. Nothing is removed: the record leaves the
 * lists, its costs, jobs and files stay traceable, and Restore brings it back. Archiving asks
 * first; restoring does not.
 */
export function ArchiveAction(props: {
  readonly kind: ArchiveKind;
  /** API path of the record, e.g. `/content/{id}`; `/archive` and `/restore` are appended. */
  readonly path: string;
  readonly name: string;
  readonly archived: boolean;
  /** Where to go after archiving (the record's own page would show it read-only). */
  readonly afterArchive?: string | undefined;
  readonly small?: boolean | undefined;
  /** Shown instead of the button's action when archiving cannot work yet. */
  readonly blockedReason?: string | null | undefined;
}) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = props.small ? ' small' : '';

  const explain = (r: MutationResult<unknown>) => {
    const key = r.code ? REFUSAL[r.code] : undefined;
    return key ? t(key) : errorText(r);
  };

  async function run(action: 'archive' | 'restore') {
    setBusy(true);
    setError(null);
    const r = await mutate('POST', `${props.path}/${action}`, {});
    setBusy(false);
    if (!r.ok) {
      const text = explain(r);
      if (action === 'archive') setError(text);
      else toast(text);
      return;
    }
    setOpen(false);
    toast(
      action === 'archive'
        ? t('arc.archived', { name: props.name })
        : t('arc.restored', { name: props.name }),
    );
    if (action === 'archive' && props.afterArchive) router.push(props.afterArchive);
    else router.refresh();
  }

  if (props.archived) {
    return (
      <button
        type="button"
        className={`btn ghost${size}`}
        disabled={busy}
        onClick={() => void run('restore')}
      >
        <Icon name="restore" /> {t('arc.restore')}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`btn ghost${size}`}
        aria-label={t('arc.archiveName', { name: props.name })}
        title={props.blockedReason ?? undefined}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="archive" /> {t('arc.archive')}
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('arc.confirmTitle', { name: props.name })}
      >
        <p className="modal-desc">{t(CONSEQUENCE[props.kind])}</p>
        {props.blockedReason && (
          <p className="callout review t-13" role="note">
            {props.blockedReason}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('arc.keep')}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || Boolean(props.blockedReason)}
            onClick={() => void run('archive')}
          >
            <Icon name="archive" /> {t('arc.confirm')}
          </button>
        </div>
      </Modal>
    </>
  );
}
