import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ContentItemDto, Page, ProjectDto } from '@acf/contracts';

import { LocalTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Project · AI Content Factory' };
export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  readonly params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, content] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<Page<ContentItemDto>>(`/projects/${projectId}/content?limit=100`),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind === 'error') {
    if (project.status === 404) notFound();
    return (
      <section className="card" role="alert">
        <p>The project could not be loaded.</p>
      </section>
    );
  }
  return (
    <>
      <header className="page-header">
        <div>
          <p className="muted">
            <Link href="/projects">Projects</Link>
          </p>
          <h1>{project.data.name}</h1>
        </div>
      </header>
      {content.kind !== 'ok' ? (
        <section className="card" role="alert">
          <p>The content items could not be loaded.</p>
        </section>
      ) : content.data.data.length === 0 ? (
        <section className="card">
          <p className="muted">No content items yet.</p>
        </section>
      ) : (
        <ul className="list" aria-label="Content items">
          {content.data.data.map((item) => (
            <li key={item.id} className="card">
              <h2>
                <Link href={`/content/${item.id}`}>{item.title}</Link>
              </h2>
              <p className="muted">
                <span className="badge">{item.status}</span> · {item.targetDurationSeconds} s ·{' '}
                {item.aspectRatio} · updated <LocalTime iso={item.updatedAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
