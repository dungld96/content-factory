import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ContentMasterDetailDto, ContentMasterDto, ProjectDto } from '@acf/contracts';

import { NewMasterButton } from '@/components/forms';
import { RelativeTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';
import { isFinished } from '@/lib/content-status';
import { param, type SearchParams } from '@/lib/content-filters';
import { initials } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('masters.pageTitle') };
}

type MasterRow = ContentMasterDto & { readonly projectName: string };

/**
 * Every content master of every project (or of `?project=`, the project's Masters tab); the most
 * recently updated one is featured.
 */
export default async function MastersPage(props: { readonly searchParams: Promise<SearchParams> }) {
  const [query, all, t] = await Promise.all([
    props.searchParams,
    apiGetAll<ProjectDto>('/projects'),
    getT(),
  ]);
  const only = param(query, 'project');
  const projects =
    all.kind === 'ok' && only
      ? {
          ...all,
          data: { ...all.data, items: all.data.items.filter((p) => p.id === only) },
        }
      : all;
  if (projects.kind === 'unauthenticated') redirect('/login');
  if (projects.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('masters.loadError')}
      </section>
    );
  }
  const lists = await Promise.all(
    projects.data.items.map((p) =>
      apiGetAll<ContentMasterDto>(`/projects/${p.id}/content-masters`),
    ),
  );
  const masters: MasterRow[] = lists
    .flatMap((list, i) =>
      list.kind === 'ok'
        ? list.data.items.map((m) => ({ ...m, projectName: projects.data.items[i]?.name ?? '' }))
        : [],
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const featuredId = masters[0]?.id;
  const featured = featuredId
    ? await apiGet<ContentMasterDetailDto>(`/content-masters/${featuredId}`)
    : null;
  const detail = featured?.kind === 'ok' ? featured.data : null;

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {only && projects.data.items[0]
              ? t('masters.filtered', { name: projects.data.items[0].name })
              : t('masters.eyebrow')}
          </div>
          <h1>{t('masters.title')}</h1>
          <p>{t('masters.lead')}</p>
        </div>
        <div className="actions">
          {only && (
            <Link className="btn" href="/masters">
              {t('masters.showAll')}
            </Link>
          )}
          <NewMasterButton projects={writableProjects(projects.data.items)} />
        </div>
      </div>

      {detail && (
        <section className="card master-hero" aria-label={t('masters.featured')}>
          <div className="master-cover" aria-hidden="true">
            {initials(detail.title)}
          </div>
          <div className="master-info">
            <div className="eyebrow">
              {t('masters.recent', { project: masters[0]?.projectName ?? '' })}
            </div>
            <h2>
              <Link href={`/masters/${detail.id}`}>{detail.title}</Link>
            </h2>
            <p>
              {t('masters.sharedBrief')}
              {detail.brief.audience ? ` · ${detail.brief.audience}` : ''}
              {detail.brief.tone ? ` · ${detail.brief.tone}` : ''}
            </p>
            <div className="tags">
              <span className="tag">
                {t('masters.variantCount', { count: detail.activeVariantCount })}
              </span>
              <span className="tag">
                {t('masters.approvedCount', {
                  count: detail.variants.filter((v) => isFinished(v.status)).length,
                })}
              </span>
              <span className="tag">
                {t('masters.revision', { revision: detail.briefRevision })}
              </span>
            </div>
          </div>
          <Link className="btn" href={`/masters/${detail.id}`}>
            {t('masters.open')}
          </Link>
        </section>
      )}

      <section className="card variant-table" aria-labelledby="all-masters">
        <div className="section-head" style={{ padding: '14px 0 0' }}>
          <div>
            <h2 id="all-masters">{t('masters.all')}</h2>
            <p>{t('masters.allHint')}</p>
          </div>
        </div>
        {masters.length === 0 ? (
          <div className="empty">
            <h3>{t('masters.none')}</h3>
            {t('masters.noneHint')}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label={t('masters.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('masters.colMaster')}</th>
                  <th scope="col">{t('table.project')}</th>
                  <th scope="col">{t('masters.colVariants')}</th>
                  <th scope="col">{t('masters.colBrief')}</th>
                  <th scope="col">{t('table.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {masters.map((m) => (
                  <tr key={m.id}>
                    <td className="table-title">
                      <Link href={`/masters/${m.id}`}>{m.title}</Link>
                      <span className="subline">{m.brief.topic}</span>
                    </td>
                    <td>{m.projectName}</td>
                    <td>{m.activeVariantCount}</td>
                    <td>{t('masters.revisionShort', { revision: m.briefRevision })}</td>
                    <td>
                      <RelativeTime iso={m.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
