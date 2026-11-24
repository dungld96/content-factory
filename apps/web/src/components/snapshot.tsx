'use client';

import Link from 'next/link';

import type { ContentItemDto } from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { countByStage, STAGE_LABEL, statusInfo, type Stage } from '@/lib/content-status';

import { Icon, type IconName } from './icon';
import { RelativeTime } from './local-time';

const STAGE_MARK: Readonly<Record<Stage, IconName>> = {
  draft: 'edit',
  script: 'edit',
  storyboard: 'content',
  images: 'image',
  render: 'render',
  done: 'check',
  attention: 'warning',
};

/** Stage rows (prototype "Pipeline health" / "Production snapshot"), real counts. */
export function StageList(props: {
  readonly items: readonly ContentItemDto[];
  readonly stages?: readonly Stage[];
}) {
  const t = useT();
  const stages = props.stages ?? ['script', 'storyboard', 'images', 'done'];
  const counts = countByStage(props.items.map((i) => i.status)).filter((c) =>
    stages.includes(c.stage),
  );
  return (
    <ul className="pipeline-list" aria-label={t('snapshot.byStage')}>
      {counts.map((c) => (
        <li key={c.stage} className="pipeline-row">
          <span className="pipeline-mark" aria-hidden="true">
            <Icon name={STAGE_MARK[c.stage]} />
          </span>
          <span className="pipeline-meta">
            <b>{t(STAGE_LABEL[c.stage])}</b>
            <span>
              {c.stage === 'done'
                ? t('snapshot.allGates')
                : c.waiting > 0
                  ? t('snapshot.waiting', { count: c.waiting })
                  : c.total > 0
                    ? t('snapshot.inProgress')
                    : t('snapshot.nothing')}
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
  const t = useT();
  const recent = props.items.slice(0, props.limit ?? 5);
  if (recent.length === 0) return <p className="muted small-text">{t('snapshot.noActivity')}</p>;
  return (
    <ul className="activity" aria-label={t('snapshot.activityLabel')}>
      {recent.map((item) => (
        <li key={item.id} className="activity-item">
          <i className="activity-dot" aria-hidden="true" />
          <p>
            <Link href={`/content/${item.id}`}>
              <b>{item.title}</b>
            </Link>{' '}
            · {t(statusInfo(item.status).label)}
            <br />
            <RelativeTime iso={item.updatedAt} />
          </p>
        </li>
      ))}
    </ul>
  );
}
