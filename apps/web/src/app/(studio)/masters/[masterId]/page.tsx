import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ContentMasterDetailDto, ProjectDto } from '@acf/contracts';

import { EditMasterButton, NewVariantButton } from '@/components/forms';
import { ProductPhotos } from '@/components/product-photos';
import { ContentStatusPill, Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { isFinished } from '@/lib/content-status';
import { formatLabel, initials, platformLabel, specLabel } from '@/lib/format';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('master.pageTitle') };
}

/** A content master and its variants (R0, ADR-0015). */
export default async function MasterPage({
  params,
}: {
  readonly params: Promise<{ masterId: string }>;
}) {
  const { masterId } = await params;
  const [master, t] = await Promise.all([
    apiGet<ContentMasterDetailDto>(`/content-masters/${masterId}`),
    getT(),
  ]);
  if (master.kind === 'unauthenticated') redirect('/login');
  if (master.kind === 'error') {
    if (master.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        {t('master.loadError')}
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
              {project.kind === 'ok' ? project.data.name : t('table.project')}
            </Link>{' '}
            / {t('master.crumb')}
          </div>
          <h1>{m.title}</h1>
          <p>{t('masters.lead')}</p>
        </div>
        <div className="actions">
          {m.archivedAt && <Pill tone="gray">{t('projects.archived')}</Pill>}
          {canEdit && <EditMasterButton master={m} />}
        </div>
      </div>

      <section className="card master-hero" aria-label={t('master.summary')}>
        <div className="master-cover" aria-hidden="true">
          {initials(m.title)}
        </div>
        <div className="master-info">
          <div className="eyebrow">{t('master.sharedRevision', { revision: m.briefRevision })}</div>
          <p>
            {m.language.toUpperCase()}
            {m.brief.audience ? ` · ${m.brief.audience}` : ''}
            {m.brief.tone ? ` · ${m.brief.tone}` : ''}
          </p>
          <div className="tags">
            <span className="tag">
              {t('masters.variantCount', { count: m.activeVariantCount })}
            </span>
            <span className="tag">{t('masters.approvedCount', { count: approved })}</span>
            <span className="tag">{t('masters.revision', { revision: m.briefRevision })}</span>
          </div>
          <ProductPhotos
            projectId={m.projectId}
            brief={m.brief}
            endpoint={`/content-masters/${m.id}`}
            canEdit={canEdit && m.archivedAt === null}
            savedText={t('master.photosSaved')}
          />
        </div>
      </section>

      <section className="card variant-table" aria-labelledby="variants">
        <div className="section-head" style={{ padding: '14px 0 0' }}>
          <div>
            <h2 id="variants">{t('master.variants')}</h2>
            <p>{t('master.variantsHint')}</p>
          </div>
          {canEdit && <NewVariantButton masterId={m.id} language={m.language} />}
        </div>
        {m.variants.length === 0 ? (
          <div className="empty">{t('master.noVariants')}</div>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label={t('master.variants')}>
              <thead>
                <tr>
                  <th scope="col">{t('master.colVariant')}</th>
                  <th scope="col">{t('table.format')}</th>
                  <th scope="col">{t('table.platform')}</th>
                  <th scope="col">{t('master.colSpec')}</th>
                  <th scope="col">{t('table.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('table.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {m.variants.map((v) => (
                  <tr key={v.id}>
                    <td className="table-title">
                      <Link href={`/content/${v.id}`}>{v.title}</Link>
                    </td>
                    <td>{formatLabel(t, v.format)}</td>
                    <td>{platformLabel(t, v.targetPlatform)}</td>
                    <td>{specLabel(v)}</td>
                    <td>
                      <span className="actions">
                        <ContentStatusPill status={v.status} />
                        {v.masterBriefStale && <Pill tone="amber">{t('master.changed')}</Pill>}
                        {v.archivedAt && <Pill tone="gray">{t('projects.archived')}</Pill>}
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
            <h2 id="source">{t('master.source')}</h2>
            <p>{t('master.sourceHint')}</p>
          </div>
          <Link className="link" href={`/assets?project=${m.projectId}`}>
            {t('master.browseAssets')}
          </Link>
        </div>
        <div className="brief-box">
          <span className="box-label">{t('master.coreIdea')}</span>
          <p>{m.brief.topic}</p>
          <div className="tags">
            {m.brief.audience && (
              <span className="tag">{t('master.audience', { value: m.brief.audience })}</span>
            )}
            {m.brief.objective && (
              <span className="tag">{t('master.objective', { value: m.brief.objective })}</span>
            )}
            {m.brief.tone && (
              <span className="tag">{t('master.tone', { value: m.brief.tone })}</span>
            )}
            {m.brief.callToAction && (
              <span className="tag">{t('master.cta', { value: m.brief.callToAction })}</span>
            )}
          </div>
          {m.brief.notes && <p className="brief-meta">{m.brief.notes}</p>}
        </div>
      </section>
    </>
  );
}
