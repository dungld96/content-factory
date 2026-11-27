'use client';

import Link from 'next/link';

import type { ContentItemDto } from '@acf/contracts';

import { ArchiveAction } from '@/components/archive-action';
import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { formatLabel, platformLabel } from '@/lib/format';

import { RelativeTime } from './local-time';
import { ContentStatusPill } from './status-pill';

type Row = ContentItemDto & { readonly projectName?: string };

/**
 * Content items as the prototype's library table. `showProject` adds the project column
 * (workspace-wide lists); otherwise the project name is omitted.
 */
export function ContentTable(props: {
  readonly items: readonly Row[];
  readonly label: string;
  readonly showProject?: boolean;
  readonly compact?: boolean;
  /** Archived items: the last column restores instead of opening. */
  readonly restore?: boolean;
}) {
  const t = useT();
  return (
    <div className="table-wrap">
      <table className="table" aria-label={props.label}>
        <thead>
          <tr>
            <th scope="col">{t('table.content')}</th>
            {props.showProject && <th scope="col">{t('table.project')}</th>}
            <th scope="col">{t('table.format')}</th>
            {!props.compact && <th scope="col">{t('table.platform')}</th>}
            <th scope="col">{t('table.status')}</th>
            <th scope="col">{t('table.updated')}</th>
            <th scope="col">
              <span className="sr-only">{t('table.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr key={item.id}>
              <td className="table-title">
                <span className="title-cell">
                  {!props.compact && (
                    <span className="thumb-mini" aria-hidden="true">
                      <Icon name="play" size={14} />
                    </span>
                  )}
                  <span>
                    <Link href={`/content/${item.id}`}>{item.title}</Link>
                    <span className="subline">
                      {props.compact
                        ? `${platformLabel(t, item.targetPlatform)} · ${item.language.toUpperCase()}`
                        : `${String(item.targetDurationSeconds)}s · ${item.language.toUpperCase()}`}
                    </span>
                  </span>
                </span>
              </td>
              {props.showProject && <td>{item.projectName}</td>}
              <td>
                {props.compact
                  ? t('table.video', { ratio: item.aspectRatio })
                  : `${formatLabel(t, item.format)} · ${item.aspectRatio}`}
              </td>
              {!props.compact && <td>{platformLabel(t, item.targetPlatform)}</td>}
              <td>
                <ContentStatusPill status={item.status} />
              </td>
              <td>
                <RelativeTime iso={item.updatedAt} />
              </td>
              <td>
                {props.restore ? (
                  <ArchiveAction
                    kind="content"
                    path={`/content/${item.id}`}
                    name={item.title}
                    archived
                    small
                  />
                ) : (
                  <Link
                    href={`/content/${item.id}`}
                    className="row-arrow"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    →
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
