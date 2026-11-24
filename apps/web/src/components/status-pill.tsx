'use client';

import type { ContentStatus } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { statusInfo, type Tone } from '@/lib/content-status';
import type { MessageKey } from '@/lib/i18n';

export function Pill(props: {
  readonly tone: Tone;
  readonly children: React.ReactNode;
  readonly label?: string | undefined;
}) {
  return (
    <span className={`status ${props.tone}`} aria-label={props.label}>
      {props.children}
    </span>
  );
}

export function ContentStatusPill(props: {
  readonly status: ContentStatus;
  readonly label?: string | undefined;
}) {
  const t = useT();
  const info = statusInfo(props.status);
  return (
    <Pill tone={info.tone} label={props.label}>
      {t(info.label)}
    </Pill>
  );
}

const VERSION_STATUS: Readonly<Record<string, { label: MessageKey; tone: Tone }>> = {
  approved: { label: 'version.approved', tone: 'green' },
  rejected: { label: 'version.rejected', tone: 'red' },
  pending_review: { label: 'version.pending_review', tone: 'amber' },
};

/** Review status of a script or storyboard version. */
export function VersionPill({ status }: { readonly status: string }) {
  const t = useT();
  const info = VERSION_STATUS[status];
  return <Pill tone={info?.tone ?? 'gray'}>{info ? t(info.label) : status}</Pill>;
}

const APPROVAL: Readonly<Record<string, { label: MessageKey; tone: Tone }>> = {
  approved: { label: 'approval.approved', tone: 'green' },
  rejected: { label: 'approval.rejected', tone: 'red' },
  pending: { label: 'approval.pending', tone: 'amber' },
  changes_requested: { label: 'approval.changes_requested', tone: 'amber' },
};

/** Approval status of an asset (lower-case, as the API names it). */
export function ApprovalPill({ status }: { readonly status: string }) {
  const t = useT();
  const info = APPROVAL[status];
  return <Pill tone={info?.tone ?? 'gray'}>{info ? t(info.label) : status.replace('_', ' ')}</Pill>;
}
