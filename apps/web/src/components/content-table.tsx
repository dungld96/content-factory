import Link from 'next/link';

import type { ContentItemDto } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { FORMAT_LABEL, platformLabel } from '@/lib/format';

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
}) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label={props.label}>
        <thead>
          <tr>
            <th scope="col">Content</th>
            {props.showProject && <th scope="col">Project</th>}
            <th scope="col">Format</th>
            {!props.compact && <th scope="col">Platform</th>}
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr-only">Open</span>
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
                        ? `${platformLabel(item.targetPlatform)} · ${item.language.toUpperCase()}`
                        : `${String(item.targetDurationSeconds)}s · ${item.language.toUpperCase()}`}
                    </span>
                  </span>
                </span>
              </td>
              {props.showProject && <td>{item.projectName}</td>}
              <td>
                {props.compact
                  ? `${item.aspectRatio} video`
                  : `${FORMAT_LABEL[item.format]} · ${item.aspectRatio}`}
              </td>
              {!props.compact && <td>{platformLabel(item.targetPlatform)}</td>}
              <td>
                <ContentStatusPill status={item.status} />
              </td>
              <td>
                <RelativeTime iso={item.updatedAt} />
              </td>
              <td>
                <Link
                  href={`/content/${item.id}`}
                  className="row-arrow"
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
