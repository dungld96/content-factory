import type { ContentStatus } from '@acf/contracts';

import { statusInfo, type Tone } from '@/lib/content-status';

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
  const info = statusInfo(props.status);
  return (
    <Pill tone={info.tone} label={props.label}>
      {info.label}
    </Pill>
  );
}

const VERSION_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
  pending_review: { label: 'Pending review', tone: 'amber' },
};

/** Review status of a script or storyboard version. */
export function VersionPill({ status }: { readonly status: string }) {
  const info = VERSION_STATUS[status] ?? { label: status, tone: 'gray' as const };
  return <Pill tone={info.tone}>{info.label}</Pill>;
}

const APPROVAL: Readonly<Record<string, Tone>> = {
  approved: 'green',
  rejected: 'red',
  pending: 'amber',
  changes_requested: 'amber',
};

/** Approval status of an asset (lower-case, as the API names it). */
export function ApprovalPill({ status }: { readonly status: string }) {
  return <Pill tone={APPROVAL[status] ?? 'gray'}>{status.replace('_', ' ')}</Pill>;
}
