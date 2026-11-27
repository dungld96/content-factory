'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { MemberDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';

const ROLE_LABEL = { owner: 'role.owner', editor: 'role.editor', viewer: 'role.viewer' } as const;

/**
 * The members of a project; an owner of an active project can remove one. Removal ends access
 * at once; their past work (content, approvals, costs) stays attributed to them. A project keeps
 * at least one owner (`409 LAST_OWNER`).
 */
export function ProjectMembers(props: {
  readonly projectId: string;
  readonly members: readonly MemberDto[];
  readonly canRemove: boolean;
  readonly selfId: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const owners = props.members.filter((m) => m.role === 'owner').length;

  async function remove(m: MemberDto) {
    const name = m.displayName || m.email;
    if (!window.confirm(t('members.removeQ', { name }))) return;
    setBusy(m.userId);
    const r = await mutate('DELETE', `/projects/${props.projectId}/members/${m.userId}`);
    setBusy(null);
    if (!r.ok) {
      toast(r.code === 'LAST_OWNER' ? t('members.lastOwner') : errorText(r));
      return;
    }
    toast(t('members.removed', { name }));
    if (m.userId === props.selfId) router.push('/projects');
    else router.refresh();
  }

  return (
    <section className="card card-pad" style={{ marginTop: 16 }} aria-labelledby="project-members">
      <div className="section-head">
        <div>
          <h2 id="project-members">{t('members.title')}</h2>
          <p>{t('members.hint')}</p>
        </div>
      </div>
      <ul className="plain-list" aria-label={t('members.title')}>
        {props.members.map((m) => (
          <li key={m.userId} className="job-row member-row">
            <span className="member-name">
              <b>{m.displayName || m.email}</b>
              <span className="t-12 muted"> {m.email}</span>
            </span>
            <span className="tag">{t(ROLE_LABEL[m.role])}</span>
            {props.canRemove && !(m.role === 'owner' && owners === 1) && (
              <button
                type="button"
                className="btn ghost small"
                disabled={busy !== null}
                aria-label={t('members.removeName', { name: m.displayName || m.email })}
                onClick={() => void remove(m)}
              >
                <Icon name="userMinus" /> {t('members.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
