import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ContentMasterDetailDto, ProjectDto } from '@acf/contracts';

import { EditMasterButton, NewVariantButton } from '@/components/forms';
import { ProductPhotos } from '@/components/product-photos';
import { ContentStatusPill, Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { isFinished } from '@/lib/content-status';
import { FORMAT_LABEL, initials, platformLabel, specLabel } from '@/lib/format';

export const metadata: Metadata = { title: 'Content master · Content Studio' };
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
      <section className="card notice error" role="alert">
        The content master could not be loaded.
      </section>
    );
  }
  const m = master.data;
  const project = await apiGet<ProjectDto>(`/projects/${m.projectId}`);
  const canEdit = project.kind === 'ok' && project.data.role !== 'viewer' && m.archivedAt === null;
  const approved = m.variants.filter((v) => isFinished(v.status)).length;

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href={`/projects/${m.projectId}`}>
              {project.kind === 'ok' ? project.data.name : 'Project'}
            </Link>{' '}
            / Content master
          </div>
          <h1>{m.title}</h1>
          <p>One core idea. Multiple channel-ready content variants.</p>
        </div>
        <div className="actions">
          {m.archivedAt && <Pill tone="gray">Archived</Pill>}
          {canEdit && <EditMasterButton master={m} />}
        </div>
      </div>

      <section className="card master-hero" aria-label="Master summary">
        <div className="master-cover" aria-hidden="true">
          {initials(m.title)}
        </div>
        <div className="master-info">
          <div className="eyebrow">Shared brief · revision {m.briefRevision}</div>
          <p>
            {m.language.toUpperCase()}
            {m.brief.audience ? ` · ${m.brief.audience}` : ''}
            {m.brief.tone ? ` · ${m.brief.tone}` : ''}
          </p>
          <div className="tags">
            <span className="tag">
              {m.activeVariantCount} variant{m.activeVariantCount === 1 ? '' : 's'}
            </span>
            <span className="tag">{approved} approved</span>
            <span className="tag">Brief revision {m.briefRevision}</span>
          </div>
          <ProductPhotos
            projectId={m.projectId}
            brief={m.brief}
            endpoint={`/content-masters/${m.id}`}
            canEdit={canEdit && m.archivedAt === null}
            savedText="Product photos saved in the master brief. Resync variants to use them."
          />
        </div>
      </section>

      <section className="card variant-table" aria-labelledby="variants">
        <div className="section-head" style={{ padding: '14px 0 0' }}>
          <div>
            <h2 id="variants">Variants</h2>
            <p>Independent production workflows derived from this master</p>
          </div>
          {canEdit && <NewVariantButton masterId={m.id} language={m.language} />}
        </div>
        {m.variants.length === 0 ? (
          <div className="empty">No variants yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Variants">
              <thead>
                <tr>
                  <th scope="col">Variant</th>
                  <th scope="col">Format</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Specification</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {m.variants.map((v) => (
                  <tr key={v.id}>
                    <td className="table-title">
                      <Link href={`/content/${v.id}`}>{v.title}</Link>
                    </td>
                    <td>{FORMAT_LABEL[v.format]}</td>
                    <td>{platformLabel(v.targetPlatform)}</td>
                    <td>{specLabel(v)}</td>
                    <td>
                      <span className="actions">
                        <ContentStatusPill status={v.status} />
                        {v.masterBriefStale && <Pill tone="amber">Master changed</Pill>}
                        {v.archivedAt && <Pill tone="gray">Archived</Pill>}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/content/${v.id}`}
                        className="row-arrow"
                        aria-hidden="true"
                        tabIndex={-1}
                      >
                        →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad" style={{ marginTop: 16 }} aria-labelledby="source">
        <div className="section-head">
          <div>
            <h2 id="source">Shared source material</h2>
            <p>Brief and context inherited by new variants</p>
          </div>
          <Link className="link" href={`/assets?project=${m.projectId}`}>
            Browse assets →
          </Link>
        </div>
        <div className="brief-box">
          <span className="box-label">Core idea</span>
          <p>{m.brief.topic}</p>
          <div className="tags">
            {m.brief.audience && <span className="tag">Audience · {m.brief.audience}</span>}
            {m.brief.objective && <span className="tag">Objective · {m.brief.objective}</span>}
            {m.brief.tone && <span className="tag">Tone · {m.brief.tone}</span>}
            {m.brief.callToAction && <span className="tag">CTA · {m.brief.callToAction}</span>}
          </div>
          {m.brief.notes && <p className="brief-meta">{m.brief.notes}</p>}
        </div>
      </section>
    </>
  );
}
