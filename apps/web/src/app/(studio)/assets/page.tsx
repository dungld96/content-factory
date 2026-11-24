import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type { AssetDto, CollectionListDto, Page, ProjectDto } from '@acf/contracts';

import { UploadAssetButton } from '@/components/forms';
import { QueryFilters } from '@/components/query-filters';
import { apiGet } from '@/lib/api-server';
import { param, type SearchParams } from '@/lib/content-filters';
import { getT } from '@/lib/i18n/server';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

import { AssetBrowser, NewCollectionForm, type AssetRow } from './asset-browser';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('library.pageTitle') };
}

const PAGE_SIZE = 60;

const TYPES = ['reference', 'image', 'video', 'audio', 'render', 'subtitle'] as const;

/** Reference images, generated images, clips and audio with their provenance (prototype "Asset library"). */
export default async function AssetsPage(props: { readonly searchParams: Promise<SearchParams> }) {
  const [query, projects, t] = await Promise.all([
    props.searchParams,
    apiGetAll<ProjectDto>('/projects'),
    getT(),
  ]);
  if (projects.kind === 'unauthenticated') redirect('/login');
  if (projects.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('library.loadError')}
      </section>
    );
  }
  const projectId = param(query, 'project');
  const type = TYPES.find((value) => value === param(query, 'type'));
  const q = param(query, 'q')?.trim().slice(0, 100);
  const review = param(query, 'review') === 'pending';
  const scope = projects.data.items.filter((p) => !projectId || p.id === projectId);
  // P2b L5: collections are per project, so they are offered once a project is chosen.
  const selectedProject = projectId ? scope[0] : undefined;
  const collections = selectedProject
    ? await apiGet<CollectionListDto>(`/projects/${selectedProject.id}/collections`)
    : null;
  const collectionList = collections?.kind === 'ok' ? collections.data.data : [];
  const collectionId = collectionList.find((c) => c.id === param(query, 'collection'))?.id;
  // P2b L1: the API filters and pages; one page per project.
  const filters = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (type) filters.set('assetType', type);
  if (review) filters.set('approvalStatus', 'pending');
  if (q) filters.set('q', q);
  if (collectionId) filters.set('collectionId', collectionId);
  const lists = await Promise.all(
    scope.map((p) => apiGet<Page<AssetDto>>(`/projects/${p.id}/assets?${filters.toString()}`)),
  );
  const failed = lists.some((l) => l.kind !== 'ok');
  const truncated = lists.some((l) => l.kind === 'ok' && l.data.page.nextCursor !== null);
  const assets: AssetRow[] = lists
    .flatMap((list, i) =>
      list.kind === 'ok'
        ? list.data.data.map((a) => ({
            ...a,
            projectName: scope[i]?.name ?? '',
            canEdit: scope[i]?.role !== 'viewer' && scope[i]?.archivedAt === null,
          }))
        : [],
    )

    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const writable = writableProjects(projects.data.items);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('library.eyebrow')}</div>
          <h1>{t('library.title')}</h1>
          <p>{t('library.lead')}</p>
        </div>
        <div className="actions">
          <UploadAssetButton
            projects={writable}
            projectId={writable.some((p) => p.id === projectId) ? projectId : undefined}
          />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: t('library.search') }}
        selects={[
          {
            name: 'type',
            label: t('library.type'),
            allLabel: t('library.allTypes'),
            options: TYPES.map((value) => ({ value, label: t(`library.type.${value}`) })),
          },
          {
            name: 'review',
            label: t('library.review'),
            allLabel: t('library.anyReview'),
            options: [{ value: 'pending', label: t('library.needsReview') }],
          },
          {
            name: 'project',
            label: t('filter.project'),
            allLabel: t('filter.allProjects'),
            // Two projects can share a name: add the slug then (UX review F13).
            options: projects.data.items.map((p, _, all) => ({
              value: p.id,
              label:
                all.filter((x) => x.name === p.name).length > 1 ? `${p.name} (${p.slug})` : p.name,
            })),
          },
          ...(selectedProject
            ? [
                {
                  name: 'collection',
                  label: t('picker.collection'),
                  allLabel: t('picker.allAssets'),
                  options: collectionList.map((c) => ({
                    value: c.id,
                    label: `${c.name} (${String(c.itemCount)})`,
                  })),
                },
              ]
            : []),
        ]}
        count={t('library.count', { count: assets.length })}
      />

      {truncated && (
        <p className="muted small-text" role="status">
          {t('library.truncated', { size: PAGE_SIZE })}
        </p>
      )}
      {failed && (
        <p className="notice error" role="alert">
          {t('library.partial')}
        </p>
      )}
      {selectedProject && writable.some((p) => p.id === selectedProject.id) && (
        <NewCollectionForm projectId={selectedProject.id} />
      )}
      <AssetBrowser
        assets={assets}
        collections={collectionList}
        activeCollectionId={collectionId ?? null}
      />
    </>
  );
}
