import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ContentItemDto, ContentMasterDto, ProjectDto } from '@acf/contracts';

import { ContentTable } from '@/components/content-table';
import { NewContentButton } from '@/components/forms';
import { QueryFilters } from '@/components/query-filters';
import { RecentActivity, StageList } from '@/components/snapshot';
import { apiGet } from '@/lib/api-server';
import {
  contentFilterFrom,
  filterContent,
  PLATFORM_SELECT,
  STATUS_SELECT,
  type SearchParams,
} from '@/lib/content-filters';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Project · Content Studio' };
export const dynamic = 'force-dynamic';

/** A project's content library (prototype "Content library", scoped to one project). */
export default async function ProjectPage(props: {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const [{ projectId }, query] = await Promise.all([props.params, props.searchParams]);
  const [project, content, masters] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGetAll<ContentItemDto>(`/projects/${projectId}/content`),
    apiGetAll<ContentMasterDto>(`/projects/${projectId}/content-masters`),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind === 'error') {
    if (project.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        The project could not be loaded.
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
            <Link href="/projects">Projects</Link> / Production
          </div>
          <h1>{project.data.name}</h1>
          <p>
            {project.data.description ?? 'Every idea, version and production status in one place.'}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href={`/assets?project=${projectId}`}>
            <span aria-hidden="true">▧</span> Assets
          </Link>
          {writable.length > 0 && <NewContentButton projects={writable} projectId={projectId} />}
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: 'Search content…' }}
        selects={[STATUS_SELECT, PLATFORM_SELECT]}
        count={`${String(shown.length)} of ${String(items.length)} items`}
      />

      <div className="content-layout">
        <section className="card content-table">
          {content.kind !== 'ok' ? (
            <p className="notice error" role="alert">
              The content items could not be loaded.
            </p>
          ) : shown.length === 0 ? (
            <div className="empty">
              <h2>{filtered ? 'No matching content' : 'No content items yet'}</h2>
              {filtered ? 'Try another search or filter.' : 'Create content to start a production.'}
            </div>
          ) : (
            <ContentTable items={shown} label="Content items" />
          )}
        </section>
        <aside className="card side-card">
          <h3>Production snapshot</h3>
          <StageList items={items} stages={['draft', 'script', 'storyboard', 'images', 'done']} />
          <hr />
          <h3>Content masters</h3>
          {masters.kind !== 'ok' || masters.data.items.length === 0 ? (
            <p className="muted small-text">No content masters yet.</p>
          ) : (
            <ul className="activity" aria-label="Content masters">
              {masters.data.items.slice(0, 6).map((m) => (
                <li key={m.id} className="activity-item">
                  <i className="activity-dot" aria-hidden="true" />
                  <p>
                    <Link href={`/masters/${m.id}`}>
                      <b>{m.title}</b>
                    </Link>
                    <br />
                    {m.activeVariantCount} variant{m.activeVariantCount === 1 ? '' : 's'} · brief r
                    {m.briefRevision}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <hr />
          <h3>Recent activity</h3>
          <RecentActivity items={items} limit={4} />
        </aside>
      </div>
    </>
  );
}
