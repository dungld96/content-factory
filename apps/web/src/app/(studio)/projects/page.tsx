import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ChannelDto, ContentItemDto, ProjectDto } from '@acf/contracts';

import { NewProjectButton } from '@/components/forms';
import { QueryFilters } from '@/components/query-filters';
import { Pill } from '@/components/status-pill';
import { isInProduction } from '@/lib/content-status';
import { param, type SearchParams } from '@/lib/content-filters';
import { initials, paletteIndex } from '@/lib/format';
import { apiGetAll } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Projects · Content Studio' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

const VISIBILITY = {
  name: 'show',
  label: 'Visibility',
  allLabel: 'Active projects',
  options: [
    { value: 'archived', label: 'Archived' },
    { value: 'all', label: 'All projects' },
  ],
} as const;

interface ProjectMetrics {
  readonly content: number;
  readonly inProduction: number;
  readonly channels: number;
}

async function metricsOf(project: ProjectDto): Promise<ProjectMetrics | null> {
  const [content, channels] = await Promise.all([
    apiGetAll<ContentItemDto>(`/projects/${project.id}/content`),
    apiGetAll<ChannelDto>(`/projects/${project.id}/channels`),
  ]);
  if (content.kind !== 'ok' || channels.kind !== 'ok') return null;
  return {
    content: content.data.items.length,
    inProduction: content.data.items.filter((c) => isInProduction(c.status)).length,
    channels: channels.data.items.length,
  };
}

export default async function ProjectsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await props.searchParams;
  const show = param(params, 'show');
  const q = param(params, 'q')?.toLocaleLowerCase();
  const projects = await apiGetAll<ProjectDto>(
    show === 'archived' || show === 'all' ? '/projects?includeArchived=true' : '/projects',
  );
  if (projects.kind === 'unauthenticated') redirect('/login');

  const visible =
    projects.kind === 'ok'
      ? projects.data.items.filter(
          (p) =>
            (show !== 'archived' || p.archivedAt !== null) &&
            (!q ||
              p.name.toLocaleLowerCase().includes(q) ||
              (p.description ?? '').toLocaleLowerCase().includes(q)),
        )
      : [];
  const metrics = await Promise.all(visible.map(metricsOf));

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Projects</h1>
          <p>Organize content production by brand, channel, or campaign.</p>
        </div>
        <div className="actions">
          <NewProjectButton />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: 'Search projects…' }}
        selects={[VISIBILITY]}
        count={`${String(visible.length)} project${visible.length === 1 ? '' : 's'}`}
      />

      {projects.kind === 'error' ? (
        <section className="card notice error" role="alert">
          The projects could not be loaded
          {projects.status ? ` (HTTP ${String(projects.status)})` : ''}. Reload the page to try
          again.
        </section>
      ) : visible.length === 0 ? (
        <section className="card empty" aria-labelledby="no-projects">
          <h2 id="no-projects">{q || show ? 'No matching projects' : 'No projects yet'}</h2>
          <p>
            {q || show
              ? 'Try another search or filter.'
              : 'Create a project, or ask a project owner to add you.'}
          </p>
        </section>
      ) : (
        <ul className="project-grid" aria-label="Your projects">
          {visible.map((project, i) => {
            const m = metrics[i];
            return (
              <li key={project.id}>
                <article className="card project-card">
                  <div className="project-top">
                    <span
                      className={`project-logo logo-${String(paletteIndex(project.id))}`}
                      aria-hidden="true"
                    >
                      {initials(project.name)}
                    </span>
                    <span className="actions">
                      <span className="tag">{ROLE_LABEL[project.role]}</span>
                      {project.archivedAt ? (
                        <Pill tone="gray">Archived</Pill>
                      ) : (
                        <Pill tone="green">Active</Pill>
                      )}
                    </span>
                  </div>
                  <h3>
                    <Link href={`/projects/${project.id}`}>{project.name}</Link>
                  </h3>
                  <p>{project.description ?? `${project.defaultLanguage} · ${project.timezone}`}</p>
                  <div className="project-metrics">
                    {m ? (
                      <>
                        <div>
                          <b>{m.content}</b>
                          <span>Content items</span>
                        </div>
                        <div>
                          <b>{m.inProduction}</b>
                          <span>In production</span>
                        </div>
                        <div>
                          <b>{m.channels}</b>
                          <span>Channel{m.channels === 1 ? '' : 's'}</span>
                        </div>
                      </>
                    ) : (
                      <span>Metrics unavailable</span>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
