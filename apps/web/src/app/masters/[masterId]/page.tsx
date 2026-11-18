import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ContentMasterDetailDto, ProjectDto } from '@acf/contracts';

import { apiGet } from '@/lib/api-server';

import { NewVariantForm } from '../../projects/[projectId]/project-controls';

export const metadata: Metadata = { title: 'Content master · AI Content Factory' };
export const dynamic = 'force-dynamic';

/** A content master and its variants (R0, ADR-0015). */
export default async function MasterPage({
  params,
}: {
  readonly params: Promise<{ masterId: string }>;
}) {
  const { masterId } = await params;
  const master = await apiGet<ContentMasterDetailDto>(`/content-masters/${masterId}`);
  if (master.kind === 'unauthenticated') redirect('/login');
  if (master.kind === 'error') {
    if (master.status === 404) notFound();
    return (
      <section className="card" role="alert">
        <p>The content master could not be loaded.</p>
      </section>
    );
  }
  const m = master.data;
  const project = await apiGet<ProjectDto>(`/projects/${m.projectId}`);
  const canEdit = project.kind === 'ok' && project.data.role !== 'viewer' && m.archivedAt === null;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="muted">
            <Link href={`/projects/${m.projectId}`}>
              {project.kind === 'ok' ? project.data.name : 'Project'}
            </Link>
          </p>
          <h1>{m.title}</h1>
        </div>
        <span className="badge">brief r{m.briefRevision}</span>
      </header>
      <section className="card" aria-labelledby="brief">
        <h2 id="brief">Shared brief</h2>
        <p>{m.brief.topic}</p>
        <p className="muted">
          {m.language}
          {m.brief.audience ? ` · for ${m.brief.audience}` : ''}
        </p>
      </section>
      <section className="card" aria-labelledby="variants">
        <h2 id="variants">Variants</h2>
        {m.variants.length === 0 ? (
          <p className="muted">No variants yet.</p>
        ) : (
          <table aria-label="Variants">
            <thead>
              <tr>
                <th>Title</th>
                <th>Format</th>
                <th>Platform</th>
                <th>Spec</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {m.variants.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link href={`/content/${v.id}`}>{v.title}</Link>
                  </td>
                  <td>{v.format}</td>
                  <td>{v.targetPlatform ?? '—'}</td>
                  <td>
                    {v.targetDurationSeconds} s · {v.aspectRatio} · {v.language}
                  </td>
                  <td>
                    <span className="badge">{v.status}</span>{' '}
                    {v.masterBriefStale && <span className="badge badge-warn">Master changed</span>}
                    {v.archivedAt && <span className="badge">archived</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && <NewVariantForm masterId={m.id} language={m.language} />}
      </section>
    </>
  );
}
