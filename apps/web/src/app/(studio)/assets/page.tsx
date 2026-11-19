import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type { AssetDto, ProjectDto } from '@acf/contracts';

import { UploadAssetButton } from '@/components/forms';
import { QueryFilters } from '@/components/query-filters';
import { param, type SearchParams } from '@/lib/content-filters';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

import { AssetBrowser, type AssetRow } from './asset-browser';

export const metadata: Metadata = { title: 'Asset library · Content Studio' };
export const dynamic = 'force-dynamic';

const TYPES = [
  { value: 'reference', label: 'Reference images' },
  { value: 'image', label: 'Generated images' },
  { value: 'video', label: 'Clips' },
  { value: 'audio', label: 'Audio' },
] as const;

/** Reference images, generated images, clips and audio with their provenance (prototype "Asset library"). */
export default async function AssetsPage(props: { readonly searchParams: Promise<SearchParams> }) {
  const query = await props.searchParams;
  const projects = await apiGetAll<ProjectDto>('/projects');
  if (projects.kind === 'unauthenticated') redirect('/login');
  if (projects.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        The asset library could not be loaded. Reload the page to try again.
      </section>
    );
  }
  const projectId = param(query, 'project');
  const type = TYPES.find((t) => t.value === param(query, 'type'))?.value;
  const q = param(query, 'q')?.toLocaleLowerCase();
  const scope = projects.data.items.filter((p) => !projectId || p.id === projectId);
  const lists = await Promise.all(
    scope.map((p) =>
      apiGetAll<AssetDto>(`/projects/${p.id}/assets${type ? `?assetType=${type}` : ''}`),
    ),
  );
  const failed = lists.some((l) => l.kind !== 'ok');
  const assets: AssetRow[] = lists
    .flatMap((list, i) =>
      list.kind === 'ok'
        ? list.data.items.map((a) => ({ ...a, projectName: scope[i]?.name ?? '' }))
        : [],
    )
    .filter(
      (a) =>
        !q ||
        (a.originalFilename ?? '').toLocaleLowerCase().includes(q) ||
        (a.label ?? '').toLocaleLowerCase().includes(q),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const writable = writableProjects(projects.data.items);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Project resources</div>
          <h1>Asset library</h1>
          <p>Reference images, audio and generated media with traceable production history.</p>
        </div>
        <div className="actions">
          <UploadAssetButton
            projects={writable}
            projectId={writable.some((p) => p.id === projectId) ? projectId : undefined}
          />
        </div>
      </div>

      <QueryFilters
        search={{ name: 'q', placeholder: 'Search assets…' }}
        selects={[
          { name: 'type', label: 'Asset type', allLabel: 'All asset types', options: TYPES },
          {
            name: 'project',
            label: 'Project',
            allLabel: 'All projects',
            options: projects.data.items.map((p) => ({ value: p.id, label: p.name })),
          },
        ]}
        count={`${String(assets.length)} asset${assets.length === 1 ? '' : 's'}`}
      />

      {failed && (
        <p className="notice error" role="alert">
          Some projects’ assets could not be loaded.
        </p>
      )}
      <AssetBrowser assets={assets} />
    </>
  );
}
