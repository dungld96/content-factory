import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { AssetDto, ContentItemDto, ContentMasterDto, Page, ProjectDto } from '@acf/contracts';

import { LocalTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';

import { NewContentForm, ReferenceUpload } from './project-controls';

export const metadata: Metadata = { title: 'Project · AI Content Factory' };
export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  readonly params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const [project, content, masters, references] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<Page<ContentItemDto>>(`/projects/${projectId}/content?limit=100`),
    apiGet<Page<ContentMasterDto>>(`/projects/${projectId}/content-masters?limit=100`),
    apiGet<Page<AssetDto>>(`/projects/${projectId}/assets?assetType=reference&limit=24`),
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
      {project.data.role !== 'viewer' && (
        <section className="card">
          <NewContentForm projectId={projectId} language={project.data.defaultLanguage} />
        </section>
      )}
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

      <section className="card" aria-labelledby="masters">
        <h2 id="masters">Content masters</h2>
        {masters.kind !== 'ok' || masters.data.data.length === 0 ? (
          <p className="muted">No content masters yet.</p>
        ) : (
          <ul aria-label="Content masters">
            {masters.data.data.map((m) => (
              <li key={m.id}>
                <Link href={`/masters/${m.id}`}>{m.title}</Link>{' '}
                <span className="muted">
                  · {m.activeVariantCount} variant(s) · brief r{m.briefRevision}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="references">
        <h2 id="references">Reference images</h2>
        {project.data.role !== 'viewer' && <ReferenceUpload projectId={projectId} />}
        {references.kind === 'ok' && references.data.data.length > 0 ? (
          <ul className="thumbs" aria-label="Reference images">
            {references.data.data.map((a) => (
              <li key={a.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated API stream */}
                <img
                  src={`/api/v1/assets/${a.id}/content`}
                  alt={a.label ?? a.originalFilename ?? 'Reference image'}
                  loading="lazy"
                />
                <p className="muted">{a.originalFilename ?? a.label ?? a.id.slice(0, 8)}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No reference images yet.</p>
        )}
      </section>
    </>
  );
}
