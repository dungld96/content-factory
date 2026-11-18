import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { MeResponse, Page, ProjectDto } from '@acf/contracts';

import { LocalTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';

import { LogoutButton } from './logout-button';

export const metadata: Metadata = { title: 'Projects · AI Content Factory' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

export default async function ProjectsPage() {
  const [me, projects] = await Promise.all([
    apiGet<MeResponse>('/auth/me'),
    apiGet<Page<ProjectDto>>('/projects?limit=100'),
  ]);
  if (me.kind === 'unauthenticated' || projects.kind === 'unauthenticated') redirect('/login');

  return (
    <>
      <header className="page-header">
        <h1>Projects</h1>
        <div className="row">
          {me.kind === 'ok' && <span className="muted">{me.data.user.displayName}</span>}
          <LogoutButton />
        </div>
      </header>

      {projects.kind === 'error' ? (
        <section className="card" role="alert">
          <p>
            The projects could not be loaded{projects.status ? ` (HTTP ${projects.status})` : ''}.
          </p>
          <p className="muted">Reload the page to try again.</p>
        </section>
      ) : projects.data.data.length === 0 ? (
        <section className="card" aria-labelledby="no-projects">
          <h2 id="no-projects">No projects yet</h2>
          <p className="muted">
            Ask a project owner to add you, or create a project through the API.
          </p>
        </section>
      ) : (
        <ul className="list" aria-label="Your projects">
          {projects.data.data.map((project) => (
            <li key={project.id} className="card">
              <h2>
                <Link href={`/projects/${project.id}`}>{project.name}</Link>
              </h2>
              <p className="muted">
                <code>{project.slug}</code> · {ROLE_LABEL[project.role]} · {project.defaultLanguage}{' '}
                · {project.timezone} · updated <LocalTime iso={project.updatedAt} />
              </p>
              {project.description && <p>{project.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
