import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type {
  BudgetDto,
  ContentItemDto,
  ContentMasterDto,
  MemberDto,
  ProjectDto,
} from '@acf/contracts';

import { ArchiveAction } from '@/components/archive-action';
import { ContentTable } from '@/components/content-table';
import { NewContentButton } from '@/components/forms';
import { ProjectMembers } from '@/components/project-members';
import { ProjectTabs } from '@/components/project-tabs';
import { QueryFilters } from '@/components/query-filters';
import { RecentActivity, StageList } from '@/components/snapshot';
import { apiGet } from '@/lib/api-server';
import { addUsd, formatUsd } from '@/lib/money';
import {
  contentFilterFrom,
  filterContent,
  platformSelect,
  statusSelect,
  type SearchParams,
} from '@/lib/content-filters';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('project.pageTitle') };
}

/** A project's content library (prototype "Content library", scoped to one project). */
export default async function ProjectPage(props: {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const [{ projectId }, query] = await Promise.all([props.params, props.searchParams]);
  const [project, content, masters, budget, members, me, t] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGetAll<ContentItemDto>(`/projects/${projectId}/content`),
    apiGetAll<ContentMasterDto>(`/projects/${projectId}/content-masters`),
    apiGet<BudgetDto>(`/projects/${projectId}/budget`),
    apiGet<{ data: MemberDto[] }>(`/projects/${projectId}/members`),
    getMe(),
    getT(),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind === 'error') {
    if (project.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        {t('project.loadError')}
      </section>
    );
  }
  const items =
    content.kind === 'ok'
      ? [...content.data.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [];
  const filter = contentFilterFrom(query);
  const shown = filterContent(items, filter);
  const filtered = Boolean(filter.q ?? filter.status ?? filter.platform);
  const writable = writableProjects([project.data]);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href="/projects">{t('nav.projects')}</Link>
          </div>
          <h1>{project.data.name}</h1>
          <p>{project.data.description ?? t('project.lead')}</p>
        </div>
        <div className="actions">
          {writable.length > 0 && <NewContentButton projects={writable} projectId={projectId} />}
          {project.data.role === 'owner' && (
            <ArchiveAction
              kind="project"
              path={`/projects/${projectId}`}
              name={project.data.name}
              archived={project.data.archivedAt !== null}
              afterArchive="/projects"
            />
          )}
        </div>
      </div>
      <ProjectTabs projectId={projectId} />

      {budget.kind === 'ok' && budget.data.warning && (
        <p className="notice" role="status">
          {t('project.budgetWarning', {
            used: formatUsd(addUsdSafe(budget.data)),
            limit: formatUsd(budget.data.monthly.limitUsd),
          })}{' '}
          <Link href={`/projects/${projectId}/costs`}>{t('project.reviewCosts')}</Link>
        </p>
      )}

      <QueryFilters
        search={{ name: 'q', placeholder: t('search.placeholder') }}
        selects={[statusSelect(t), platformSelect(t)]}
        count={t('productions.count', { shown: shown.length, total: items.length })}
      />

      <div className="content-layout">
        <section className="card content-table">
          {content.kind !== 'ok' ? (
            <p className="notice error" role="alert">
              {t('project.contentError')}
            </p>
          ) : shown.length === 0 ? (
            <div className="empty">
              <h2>{filtered ? t('productions.noMatch') : t('productions.empty')}</h2>
              {filtered ? t('productions.noMatchHint') : t('productions.emptyHint')}
            </div>
          ) : (
            <ContentTable items={shown} label={t('productions.tableLabel')} />
          )}
        </section>
        <aside className="card side-card">
          <h3>{t('productions.snapshot')}</h3>
          <StageList items={items} stages={['draft', 'script', 'storyboard', 'images', 'done']} />
          <hr />
          <h3>{t('project.mastersLabel')}</h3>
          {masters.kind !== 'ok' || masters.data.items.length === 0 ? (
            <p className="muted small-text">{t('project.noMasters')}</p>
          ) : (
            <ul className="activity" aria-label={t('project.mastersLabel')}>
              {masters.data.items.slice(0, 6).map((m) => (
                <li key={m.id} className="activity-item">
                  <i className="activity-dot" aria-hidden="true" />
                  <p>
                    <Link href={`/masters/${m.id}`}>
                      <b>{m.title}</b>
                    </Link>
                    <br />
                    {t('project.variants', {
                      count: m.activeVariantCount,
                      revision: m.briefRevision,
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <hr />
          <h3>{t('productions.recent')}</h3>
          <RecentActivity items={items} limit={4} />
        </aside>
      </div>
      {members.kind === 'ok' && (
        <ProjectMembers
          projectId={projectId}
          members={members.data.data}
          canRemove={project.data.role === 'owner' && project.data.archivedAt === null}
          selfId={me.kind === 'ok' ? me.data.user.id : null}
        />
      )}
    </>
  );
}

/** Spent + reserved + held of this month (the amount the warning refers to). */
function addUsdSafe(b: BudgetDto): string {
  return addUsd(b.spentUsd, b.reservedUsd, b.heldUsd);
}
