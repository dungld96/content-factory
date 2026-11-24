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
import { getT } from '@/lib/i18n/server';
import { apiGetAll } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('projects.pageTitle') };
}

const ROLE_LABEL = { owner: 'role.owner', editor: 'role.editor', viewer: 'role.viewer' } as const;

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
  const [params, t] = await Promise.all([props.searchParams, getT()]);
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
          <div className="eyebrow">{t('projects.eyebrow')}</div>
          <h1>{t('projects.title')}</h1>
          <p>{t('projects.lead')}</p>
        </div>
        <div className="actions">
          <NewProjectButton />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: t('projects.search') }}
        selects={[
          {
            name: 'show',
            label: t('projects.visibility'),
            allLabel: t('projects.active'),
            options: [
              { value: 'archived', label: t('projects.archived') },
              { value: 'all', label: t('projects.all') },
            ],
          },
        ]}
        count={t('projects.count', { count: visible.length })}
      />

      {projects.kind === 'error' ? (
        <section className="card notice error" role="alert">
          {t('projects.loadError', {
            status: projects.status ? ` (HTTP ${String(projects.status)})` : '',
          })}
        </section>
      ) : visible.length === 0 ? (
        <section className="card empty" aria-labelledby="no-projects">
          <h2 id="no-projects">{q || show ? t('projects.noMatch') : t('projects.none')}</h2>
          <p>{q || show ? t('productions.noMatchHint') : t('projects.noneHint')}</p>
        </section>
      ) : (
        <ul className="project-grid" aria-label={t('projects.listLabel')}>
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
                      <span className="tag">{t(ROLE_LABEL[project.role])}</span>
                      {project.archivedAt ? (
                        <Pill tone="gray">{t('projects.archived')}</Pill>
                      ) : (
                        <Pill tone="green">{t('projects.activeBadge')}</Pill>
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
                          <span>{t('projects.contentItems')}</span>
                        </div>
                        <div>
                          <b>{m.inProduction}</b>
                          <span>{t('projects.inProduction')}</span>
                        </div>
                        <div>
                          <b>{m.channels}</b>
                          <span>{t('projects.channels', { count: m.channels })}</span>
                        </div>
                      </>
                    ) : (
                      <span>{t('projects.metricsUnavailable')}</span>
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
