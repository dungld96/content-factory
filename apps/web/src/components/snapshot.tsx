import Link from 'next/link';

import type { ContentItemDto } from '@acf/contracts';

import { countByStage, STAGE_LABEL, statusInfo, type Stage } from '@/lib/content-status';

import { RelativeTime } from './local-time';

const STAGE_MARK: Readonly<Record<Stage, string>> = {
  draft: '✎',
  script: '¶',
  storyboard: '▤',
  images: '✧',
  render: '▶',
  done: '✓',
  attention: '!',
};

/** Stage rows (prototype "Pipeline health" / "Production snapshot"), real counts. */
export function StageList(props: {
  readonly items: readonly ContentItemDto[];
  readonly stages?: readonly Stage[];
}) {
  const stages = props.stages ?? ['script', 'storyboard', 'images', 'done'];
  const counts = countByStage(props.items.map((i) => i.status)).filter((c) =>
    stages.includes(c.stage),
  );
  return (
    <ul className="pipeline-list" aria-label="Content by stage">
      {counts.map((c) => (
        <li key={c.stage} className="pipeline-row">
          <span className="pipeline-mark" aria-hidden="true">
            {STAGE_MARK[c.stage]}
          </span>
          <span className="pipeline-meta">
            <b>{STAGE_LABEL[c.stage]}</b>
            <span>
              {c.stage === 'done'
                ? 'All gates approved'
                : c.waiting > 0
                  ? `${String(c.waiting)} waiting for review`
                  : c.total > 0
                    ? 'In progress'
                    : 'Nothing here'}
            </span>
          </span>
          <span className="pipeline-number">{c.total}</span>
        </li>
      ))}
    </ul>
  );
}

/** Most recently updated items as an activity list (status as of the last update). */
export function RecentActivity(props: {
  readonly items: readonly ContentItemDto[];
  readonly limit?: number;
}) {
  const recent = props.items.slice(0, props.limit ?? 5);
  if (recent.length === 0) return <p className="muted small-text">No activity yet.</p>;
  return (
    <ul className="activity" aria-label="Recent activity">
      {recent.map((item) => (
        <li key={item.id} className="activity-item">
          <i className="activity-dot" aria-hidden="true" />
          <p>
            <Link href={`/content/${item.id}`}>
              <b>{item.title}</b>
            </Link>{' '}
            · {statusInfo(item.status).label}
            <br />
            <RelativeTime iso={item.updatedAt} />
          </p>
        </li>
      ))}
    </ul>
  );
}
