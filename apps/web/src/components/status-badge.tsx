'use client';

import {
  Ban,
  Check,
  CheckCheck,
  CircleDashed,
  CircleDot,
  Clock,
  Download,
  Eye,
  LoaderCircle,
  PackageCheck,
  PencilLine,
  RefreshCw,
  Repeat,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

import { useT } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n';

/**
 * The 14 states of the redesign's status system (package §3), shared by jobs, stages, gates and
 * costs: an icon, a label and a tone, never colour alone.
 */
export type BadgeState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'review'
  | 'approved'
  | 'changes'
  | 'failed'
  | 'blocked'
  | 'budget'
  | 'delivered'
  | 'reused'
  | 'exported'
  | 'canceled'
  | 'succeeded';

export type BadgeTone = 'gray' | 'info' | 'review' | 'green' | 'amber' | 'red';

const STATES: Readonly<
  Record<
    BadgeState,
    { readonly icon: LucideIcon; readonly tone: BadgeTone; readonly label: MessageKey }
  >
> = {
  draft: { icon: CircleDashed, tone: 'gray', label: 'state.draft' },
  queued: { icon: Clock, tone: 'info', label: 'state.queued' },
  running: { icon: LoaderCircle, tone: 'info', label: 'state.running' },
  retrying: { icon: RefreshCw, tone: 'amber', label: 'state.retrying' },
  review: { icon: Eye, tone: 'review', label: 'state.review' },
  approved: { icon: Check, tone: 'green', label: 'state.approved' },
  changes: { icon: PencilLine, tone: 'amber', label: 'state.changes' },
  failed: { icon: XCircle, tone: 'red', label: 'state.failed' },
  blocked: { icon: Ban, tone: 'red', label: 'state.blocked' },
  budget: { icon: Wallet, tone: 'amber', label: 'state.budget' },
  delivered: { icon: PackageCheck, tone: 'amber', label: 'state.delivered' },
  reused: { icon: Repeat, tone: 'gray', label: 'state.reused' },
  exported: { icon: Download, tone: 'green', label: 'state.exported' },
  canceled: { icon: CircleDot, tone: 'gray', label: 'state.canceled' },
  succeeded: { icon: CheckCheck, tone: 'green', label: 'state.succeeded' },
};

export const badgeLabelKey = (state: BadgeState): MessageKey => STATES[state].label;
export const badgeTone = (state: BadgeState): BadgeTone => STATES[state].tone;

/**
 * A status badge. `label` overrides the visible text (default: the state's name in the
 * interface language); `srLabel` is a fuller name for screen readers.
 */
export function StatusBadge(props: {
  readonly state: BadgeState;
  readonly label?: string | undefined;
  readonly srLabel?: string | undefined;
  readonly tone?: BadgeTone | undefined;
}) {
  const t = useT();
  const info = STATES[props.state];
  const Icon = info.icon;
  return (
    <span
      className={`badge ${props.tone ?? info.tone}${props.state === 'running' ? ' spin' : ''}`}
      aria-label={props.srLabel}
    >
      <Icon aria-hidden="true" focusable="false" size={13} strokeWidth={2} className="badge-icon" />
      <span>{props.label ?? t(info.label)}</span>
    </span>
  );
}
