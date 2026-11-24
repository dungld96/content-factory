import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { AssetDto, CollectionListDto, Page, ProjectDto } from '@acf/contracts';

import { UploadAssetButton } from '@/components/forms';
import { Icon, type IconName } from '@/components/icon';
import { QueryFilters } from '@/components/query-filters';
import { PageCrumbs } from '@/components/shell/page-crumbs';
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

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const name of ['q', 'type', 'review', 'project', 'collection', 'view']) {
      const value = param(query, name);
      if (value) next.set(name, value);
    }
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
      else next.set(name, value);
    }
    return next.size > 0 ? `/assets?${next.toString()}` : '/assets';
  };
  const activeCollection = collectionList.find((c) => c.id === collectionId);
  const heading = activeCollection
    ? activeCollection.name
    : type
      ? t(`library.type.${type}`)
      : t('library.allAssets');
  const list = param(query, 'view') === 'list';

  return (
    <>
      <PageCrumbs
        items={[
          { label: t('library.title'), href: '/assets' },
          ...(selectedProject ? [{ label: selectedProject.name }] : []),
        ]}
      />
      <div className="lib-layout">
        <nav className="card col lib-rail" aria-label={t('library.collections')}>
          <span className="eyebrow">{t('library.collections')}</span>
          <Link
            className={!collectionId && !type ? 'coll on' : 'coll'}
            href={href({ collection: null, type: null })}
            aria-current={!collectionId && !type ? 'true' : undefined}
          >
            <Icon name="assets" />
            {t('library.allAssets')}
          </Link>
          {selectedProject ? (
            collectionList.map((c) => (
              <Link
                key={c.id}
                className={c.id === collectionId ? 'coll on' : 'coll'}
                href={href({ collection: c.id, type: null })}
                aria-current={c.id === collectionId ? 'true' : undefined}
              >
                <Icon name="folder" />
                {c.name}
                <span className="n">{c.itemCount}</span>
              </Link>
            ))
          ) : (
            <p className="t-12 muted coll-hint">{t('library.pickProject')}</p>
          )}
          {selectedProject && writable.some((p) => p.id === selectedProject.id) && (
            <NewCollectionForm projectId={selectedProject.id} />
          )}
          <div className="divider" />
          <span className="eyebrow">{t('library.generated')}</span>
          {TYPES.map((value) => (
            <Link
              key={value}
              className={type === value ? 'coll on' : 'coll'}
              href={href({ type: value, collection: null })}
              aria-current={type === value ? 'true' : undefined}
            >
              <Icon name={TYPE_ICON[value]} />
              {t(`library.type.${value}`)}
            </Link>
          ))}
        </nav>

        <section className="col lib-main" aria-label={heading}>
          <div className="row wrap lib-head">
            <h1>{heading}</h1>
            <span className="badge neutral">{assets.length}</span>
            <span className="spacer" />
            <Link className={!review ? 'chip on' : 'chip'} href={href({ review: null })}>
              {t('library.chip.all')}
            </Link>
            <Link className={review ? 'chip on' : 'chip'} href={href({ review: 'pending' })}>
              {t('library.needsReview')}
            </Link>
            <nav className="seg" aria-label={t('library.views')}>
              <Link
                href={href({ view: null })}
                className={list ? undefined : 'on'}
                aria-label={t('library.viewGrid')}
              >
                <Icon name="board" />
              </Link>
              <Link
                href={href({ view: 'list' })}
                className={list ? 'on' : undefined}
                aria-label={t('library.viewList')}
              >
                <Icon name="list" />
              </Link>
            </nav>
            <UploadAssetButton
              projects={writable}
              projectId={writable.some((p) => p.id === projectId) ? projectId : undefined}
            />
          </div>
          <div className="row wrap lib-filters">
            <QueryFilters
              search={{ name: 'q', placeholder: t('library.search') }}
              selects={[
                {
                  name: 'project',
                  label: t('filter.project'),
                  allLabel: t('filter.allProjects'),
                  // Two projects can share a name: add the slug then (UX review F13).
                  options: projects.data.items.map((p, _, all) => ({
                    value: p.id,
                    label:
                      all.filter((x) => x.name === p.name).length > 1
                        ? `${p.name} (${p.slug})`
                        : p.name,
                  })),
                },
              ]}
              count={t('library.count', { count: assets.length })}
            />
          </div>
          {truncated && (
            <p className="t-12 muted" role="status">
              {t('library.truncated', { size: PAGE_SIZE })}
            </p>
          )}
          {failed && (
            <p className="callout danger t-13" role="alert">
              {t('library.partial')}
            </p>
          )}
          <AssetBrowser
            assets={assets}
            collections={collectionList}
            activeCollectionId={collectionId ?? null}
            view={list ? 'list' : 'grid'}
          />
        </section>
      </div>
    </>
  );
}

const TYPE_ICON: Readonly<Record<(typeof TYPES)[number], IconName>> = {
  reference: 'image',
  image: 'generate',
  video: 'film',
  audio: 'mic',
  render: 'render',
  subtitle: 'edit',
};
