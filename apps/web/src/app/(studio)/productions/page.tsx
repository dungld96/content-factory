import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ContentTable } from '@/components/content-table';
import { NewContentButton } from '@/components/forms';
import { Icon } from '@/components/icon';
import { RelativeTime } from '@/components/local-time';
import { QueryFilters } from '@/components/query-filters';
import { RecentActivity, StageList } from '@/components/snapshot';
import { ContentStatusPill } from '@/components/status-pill';
import {
  contentFilterFrom,
  filterContent,
  param,
  platformSelect,
  statusSelect,
  type SearchParams,
} from '@/lib/content-filters';
import { STAGE_LABEL, statusInfo, type Stage } from '@/lib/content-status';
import type { MessageKey } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { writableProjects } from '@/lib/project-options';
import { loadWorkspace, type WorkspaceContent } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('productions.pageTitle') };
}

const COLUMNS: readonly { readonly stage: Stage; readonly hint: MessageKey }[] = [
  { stage: 'draft', hint: 'board.hint.draft' },
  { stage: 'script', hint: 'board.hint.script' },
  { stage: 'storyboard', hint: 'board.hint.storyboard' },
  { stage: 'images', hint: 'board.hint.images' },
  { stage: 'render', hint: 'board.hint.render' },
  { stage: 'done', hint: 'board.hint.done' },
];

function BoardCard({ item }: { readonly item: WorkspaceContent }) {
  return (
    <li>
      <Link href={`/content/${item.id}`} className="card board-card">
        <b>{item.title}</b>
        <span className="subline">{item.projectName}</span>
        <span className="meta">
          <ContentStatusPill status={item.status} />
          <RelativeTime iso={item.updatedAt} />
        </span>
      </Link>
    </li>
  );
}

/**
 * Productions (redesign R-D1): every content item of every project, as a filterable list
 * (`/productions`) or by stage (`?view=board`). Replaces the content library and the pipeline.
 */
export default async function ProductionsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const [workspace, t] = await Promise.all([loadWorkspace(), getT()]);
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('productions.loadError')}
      </section>
    );
  }
  const { projects, content } = workspace.data;
  const board = param(query, 'view') === 'board';
  const filter = contentFilterFrom(query);
  const shown = filterContent(content, filter);
  const filtered = Boolean(filter.q ?? filter.status ?? filter.platform ?? filter.project);
  const keep = new URLSearchParams();
  for (const name of ['q', 'status', 'platform', 'project']) {
    const value = param(query, name);
    if (value) keep.set(name, value);
  }
  const listHref = keep.size > 0 ? `/productions?${keep.toString()}` : '/productions';
  keep.set('view', 'board');
  const boardHref = `/productions?${keep.toString()}`;
  const byStage = (stage: Stage) => shown.filter((c) => statusInfo(c.status).stage === stage);
  const attention = [...byStage('render'), ...byStage('attention')];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('productions.eyebrow')}</div>
          <h1>{t('productions.title')}</h1>
          <p>{t('productions.lead')}</p>
        </div>
        <div className="actions">
          <nav className="segmented" aria-label={t('productions.views')}>
            <Link href={listHref} aria-current={board ? undefined : 'page'}>
              <Icon name="list" /> {t('productions.viewList')}
            </Link>
            <Link href={boardHref} aria-current={board ? 'page' : undefined}>
              <Icon name="board" /> {t('productions.viewBoard')}
            </Link>
          </nav>
          <Link className="btn" href="/masters">
            <Icon name="masters" /> {t('productions.masters')}
          </Link>
          <NewContentButton projects={writableProjects(projects)} />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: t('search.placeholder') }}
        selects={[
          statusSelect(t),
          platformSelect(t),
          {
            name: 'project',
            label: t('filter.project'),
            allLabel: t('filter.allProjects'),
            options: projects.map((p) => ({ value: p.id, label: p.name })),
          },
        ]}
        count={t('productions.count', { shown: shown.length, total: content.length })}
      />

      {board ? (
        <>
          {attention.length > 0 && (
            <section className="card card-pad attention-card" aria-labelledby="attention">
              <div className="section-head">
                <div>
                  <h2 id="attention">{t('productions.attention')}</h2>
                  <p>{t('productions.attentionHint')}</p>
                </div>
              </div>
              <ul className="board-cards attention-grid">
                {attention.map((item) => (
                  <BoardCard key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}
          <div className="board">
            {COLUMNS.map(({ stage, hint }) => {
              const items = byStage(stage);
              return (
                <section key={stage} className="board-column" aria-label={t(STAGE_LABEL[stage])}>
                  <h2>
                    {t(STAGE_LABEL[stage])} <span className="chip-count">{items.length}</span>
                  </h2>
                  <p className="muted small-text board-hint">{t(hint)}</p>
                  {items.length === 0 ? (
                    <p className="muted small-text">{t('productions.nothing')}</p>
                  ) : (
                    <ul className="board-cards">
                      {items.map((item) => (
                        <BoardCard key={item.id} item={item} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <div className="content-layout">
          <section className="card content-table">
            {shown.length === 0 ? (
              <div className="empty">
                <h2>{filtered ? t('productions.noMatch') : t('productions.empty')}</h2>
                {filtered ? t('productions.noMatchHint') : t('productions.emptyHint')}
              </div>
            ) : (
              <ContentTable items={shown} label={t('productions.tableLabel')} showProject />
            )}
          </section>
          <aside className="card side-card">
            <h3>{t('productions.snapshot')}</h3>
            <StageList items={content} stages={['script', 'storyboard', 'images']} />
            <hr />
            <h3>{t('productions.recent')}</h3>
            <RecentActivity items={content} />
          </aside>
        </div>
      )}
    </>
  );
}
