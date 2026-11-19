import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ContentTable } from '@/components/content-table';
import { NewContentButton } from '@/components/forms';
import { QueryFilters } from '@/components/query-filters';
import { RecentActivity, StageList } from '@/components/snapshot';
import {
  contentFilterFrom,
  filterContent,
  PLATFORM_SELECT,
  STATUS_SELECT,
  type SearchParams,
} from '@/lib/content-filters';
import { writableProjects } from '@/lib/project-options';
import { loadWorkspace } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Content library · Content Studio' };
export const dynamic = 'force-dynamic';

/** Every content item of every project (prototype "Content library"). */
export default async function ContentLibraryPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const workspace = await loadWorkspace();
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        The content library could not be loaded. Reload the page to try again.
      </section>
    );
  }
  const { projects, content } = workspace.data;
  const filter = contentFilterFrom(query);
  const shown = filterContent(content, filter);
  const filtered = Boolean(filter.q ?? filter.status ?? filter.platform ?? filter.project);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">All projects / Production</div>
          <h1>Content library</h1>
          <p>Every idea, version and production status in one place.</p>
        </div>
        <div className="actions">
          <NewContentButton projects={writableProjects(projects)} />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: 'Search content…' }}
        selects={[
          STATUS_SELECT,
          PLATFORM_SELECT,
          {
            name: 'project',
            label: 'Project',
            allLabel: 'All projects',
            options: projects.map((p) => ({ value: p.id, label: p.name })),
          },
        ]}
        count={`${String(shown.length)} of ${String(content.length)} items`}
      />

      <div className="content-layout">
        <section className="card content-table">
          {shown.length === 0 ? (
            <div className="empty">
              <h2>{filtered ? 'No matching content' : 'No content items yet'}</h2>
              {filtered ? 'Try another search or filter.' : 'Create content to start a production.'}
            </div>
          ) : (
            <ContentTable items={shown} label="Content items" showProject />
          )}
        </section>
        <aside className="card side-card">
          <h3>Production snapshot</h3>
          <StageList items={content} stages={['script', 'storyboard', 'images']} />
          <hr />
          <h3>Recent activity</h3>
          <RecentActivity items={content} />
        </aside>
      </div>
    </>
  );
}
