import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ContentTable } from '@/components/content-table';
import { Icon, type IconName } from '@/components/icon';
import { QueryFilters } from '@/components/query-filters';
import { PageCrumbs } from '@/components/shell/page-crumbs';
import {
  contentFilterFrom,
  filterContent,
  param,
  platformSelect,
  type SearchParams,
} from '@/lib/content-filters';
import { isGenerating, needsReview, statusInfo, type Stage } from '@/lib/content-status';
import { platformLabel } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { loadItemCosts, type ItemCost } from '@/lib/item-costs';
import { formatUsd } from '@/lib/money';
import { loadWorkspace, type WorkspaceContent } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('productions.pageTitle') };
}

/** Board columns: the same six stages as the workspace rail (redesign canvas). */
const COLUMNS: readonly {
  readonly stage: Stage;
  readonly label: MessageKey;
  readonly gate?: number;
}[] = [
  { stage: 'draft', label: 'board.col.draft' },
  { stage: 'script', label: 'board.col.script', gate: 1 },
  { stage: 'storyboard', label: 'board.col.storyboard', gate: 2 },
  { stage: 'images', label: 'board.col.scenes', gate: 3 },
  { stage: 'render', label: 'board.col.render', gate: 4 },
  { stage: 'done', label: 'board.col.done' },
];

type Chip = 'all' | 'needs' | 'running' | 'failed';

const CHIP_MATCH: Readonly<Record<Chip, (c: WorkspaceContent) => boolean>> = {
  all: () => true,
  needs: (c) => needsReview(c.status),
  running: (c) => isGenerating(c.status),
  failed: (c) => statusInfo(c.status).stage === 'attention' && c.status !== 'needs_input',
};

const THUMBS = ['t2', 't3', 't4', 't5', 't6', 't8'] as const;

/** A stable stand-in tone per item until it has a keyframe of its own. */
function thumbOf(item: WorkspaceContent): string {
  const stage = statusInfo(item.status).stage;
  if (stage === 'draft' || stage === 'script') return 'thumb empty';
  let hash = 0;
  for (const ch of item.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `thumb ${THUMBS[hash % THUMBS.length] ?? 't2'}`;
}

/**
 * Productions (redesign canvas): every content item of every project, as a list or a board of the
 * six stages. Chips narrow to what needs you, what runs and what failed; failed and canceled
 * items appear only under the Failed chip instead of a seventh column.
 */
export default async function ProductionsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const [workspace, costs, t] = await Promise.all([loadWorkspace(), loadItemCosts(), getT()]);
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card pad callout danger" role="alert">
        {t('productions.loadError')}
      </section>
    );
  }
  const { projects, content } = workspace.data;
  const board = param(query, 'view') === 'board';
  const rawChip = param(query, 'chip');
  const chip: Chip =
    rawChip === 'needs' || rawChip === 'running' || rawChip === 'failed' ? rawChip : 'all';
  const filter = contentFilterFrom(query);
  const base = filterContent(content, filter);
  const shown = base.filter(CHIP_MATCH[chip]);
  const filtered =
    Boolean(filter.q ?? filter.status ?? filter.platform ?? filter.project) || chip !== 'all';

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const name of ['q', 'status', 'platform', 'project', 'chip', 'view']) {
      const value = param(query, name);
      if (value) next.set(name, value);
    }
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
      else next.set(name, value);
    }
    return next.size > 0 ? `/productions?${next.toString()}` : '/productions';
  };
  const chips: readonly { readonly id: Chip; readonly label: MessageKey }[] = [
    { id: 'all', label: 'productions.chip.all' },
    { id: 'needs', label: 'productions.chip.needs' },
    { id: 'running', label: 'productions.chip.running' },
    { id: 'failed', label: 'productions.chip.failed' },
  ];
  const columns =
    chip === 'failed'
      ? [...COLUMNS, { stage: 'attention' as const, label: 'board.col.failed' as const }]
      : COLUMNS;

  return (
    <>
      <PageCrumbs items={[{ label: t('nav.productions') }]} />
      <div className="page-head">
        <div>
          <h1>{t('productions.title')}</h1>
          <p>{t('productions.lead')}</p>
        </div>
      </div>
      <div className="row wrap prod-toolbar">
        <nav className="seg" aria-label={t('productions.views')}>
          <Link
            href={href({ view: null })}
            className={board ? undefined : 'on'}
            aria-current={board ? undefined : 'page'}
          >
            <Icon name="list" /> {t('productions.viewList')}
          </Link>
          <Link
            href={href({ view: 'board' })}
            className={board ? 'on' : undefined}
            aria-current={board ? 'page' : undefined}
          >
            <Icon name="board" /> {t('productions.viewBoard')}
          </Link>
        </nav>
        <nav className="row wrap chips" aria-label={t('productions.chips')}>
          {chips.map((c) => (
            <Link
              key={c.id}
              href={href({ chip: c.id === 'all' ? null : c.id })}
              className={chip === c.id ? 'chip on' : 'chip'}
              aria-current={chip === c.id ? 'page' : undefined}
            >
              {t(c.label)} <span className="n">{base.filter(CHIP_MATCH[c.id]).length}</span>
            </Link>
          ))}
        </nav>
        <span className="spacer" />
        <QueryFilters
          search={{ name: 'q', placeholder: t('search.placeholder') }}
          selects={[
            {
              name: 'project',
              label: t('filter.project'),
              allLabel: t('filter.allProjects'),
              options: projects.map((p) => ({ value: p.id, label: p.name })),
            },
            platformSelect(t),
          ]}
          count={t('productions.count', { shown: shown.length, total: content.length })}
        />
        <Link className="btn sm" href="/masters">
          <Icon name="masters" /> {t('productions.masters')}
        </Link>
      </div>

      {board ? (
        <>
          <div className={chip === 'failed' ? 'board seven' : 'board'}>
            {columns.map((col) => {
              const items = shown.filter((c) => statusInfo(c.status).stage === col.stage);
              const waiting = items.filter((i) => needsReview(i.status)).length;
              return (
                <section key={col.stage} className="bcol" aria-label={t(col.label)}>
                  <div className="bcol-h">
                    {t(col.label)}
                    {'gate' in col && col.gate && waiting > 0 ? (
                      <span className="badge review">
                        G{col.gate} · {waiting}
                      </span>
                    ) : (
                      <span className={col.stage === 'done' ? 'badge success' : 'badge neutral'}>
                        {items.length}
                      </span>
                    )}
                  </div>
                  {items.length === 0 ? (
                    <p className="t-12 muted bcol-empty">{t('productions.nothing')}</p>
                  ) : (
                    items.map((item) => (
                      <BoardCard key={item.id} item={item} cost={costs.get(item.id)} t={t} />
                    ))
                  )}
                </section>
              );
            })}
          </div>
          <p className="t-13 muted">{t('productions.boardNote')}</p>
        </>
      ) : (
        <section className="card content-table">
          {shown.length === 0 ? (
            <div className="empty">
              <h3>{filtered ? t('productions.noMatch') : t('productions.empty')}</h3>
              <p className="muted t-13">
                {filtered ? t('productions.noMatchHint') : t('productions.emptyHint')}
              </p>
            </div>
          ) : (
            <ContentTable items={shown} label={t('productions.tableLabel')} showProject />
          )}
        </section>
      )}
    </>
  );
}

function cardBadge(
  item: WorkspaceContent,
  t: Translate,
): { tone: string; icon: IconName; text: string } {
  const info = statusInfo(item.status);
  if (needsReview(item.status)) return { tone: 'review', icon: 'eye', text: t(info.label) };
  if (isGenerating(item.status)) return { tone: 'info', icon: 'resume', text: t(info.label) };
  if (item.status === 'exported') return { tone: 'success', icon: 'download', text: t(info.label) };
  if (item.status === 'approved') return { tone: 'success', icon: 'shield', text: t(info.label) };
  if (item.status === 'failed') return { tone: 'danger', icon: 'warning', text: t(info.label) };
  if (item.status === 'draft' && !item.brief.audience) {
    return { tone: 'review outline', icon: 'warning', text: t('productions.missingAudience') };
  }
  return { tone: 'neutral', icon: 'edit', text: t(info.label) };
}

function BoardCard(props: {
  readonly item: WorkspaceContent;
  readonly cost: ItemCost | undefined;
  readonly t: Translate;
}) {
  const { item, cost, t } = props;
  const badge = cardBadge(item, t);
  return (
    <Link
      href={`/content/${item.id}`}
      className={needsReview(item.status) ? 'card bcard waiting' : 'card bcard'}
    >
      <span className="top">
        <span className={thumbOf(item)} aria-hidden="true" />
        <span className="col bcard-text">
          <b className="t-13">{item.title}</b>
          <span className="t-12 muted">
            {item.projectName} · {platformLabel(t, item.targetPlatform)}
          </span>
        </span>
      </span>
      <span className="row">
        <span className={`badge ${badge.tone}`}>
          <Icon name={badge.icon} size={13} />
          {badge.text}
        </span>
        <span className="spacer" />
        <span className="t-12 muted num" title={t('productions.costThisMonth')}>
          {cost ? `${formatUsd(cost.totalUsd)}${cost.unknownCalls > 0 ? ' + ?' : ''}` : '$0.00'}
        </span>
      </span>
    </Link>
  );
}
