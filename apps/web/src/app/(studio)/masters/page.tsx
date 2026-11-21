import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ContentMasterDetailDto, ContentMasterDto, ProjectDto } from '@acf/contracts';

import { NewMasterButton } from '@/components/forms';
import { RelativeTime } from '@/components/local-time';
import { apiGet } from '@/lib/api-server';
import { isFinished } from '@/lib/content-status';
import { initials } from '@/lib/format';
import { writableProjects } from '@/lib/project-options';
import { apiGetAll } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Content masters · Content Studio' };
export const dynamic = 'force-dynamic';

type MasterRow = ContentMasterDto & { readonly projectName: string };

/** Every content master of every project; the most recently updated one is featured. */
export default async function MastersPage() {
  const projects = await apiGetAll<ProjectDto>('/projects');
  if (projects.kind === 'unauthenticated') redirect('/login');
  if (projects.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        The content masters could not be loaded. Reload the page to try again.
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
          <div className="eyebrow">Reusable source content</div>
          <h1>Content masters</h1>
          <p>One core idea. Multiple channel-ready content variants.</p>
        </div>
        <div className="actions">
          <NewMasterButton projects={writableProjects(projects.data.items)} />
        </div>
      </div>

      {detail && (
        <section className="card master-hero" aria-label="Featured master">
          <div className="master-cover" aria-hidden="true">
            {initials(detail.title)}
          </div>
          <div className="master-info">
            <div className="eyebrow">Recently updated · {masters[0]?.projectName}</div>
            <h2>
              <Link href={`/masters/${detail.id}`}>{detail.title}</Link>
            </h2>
            <p>
              Shared brief
              {detail.brief.audience ? ` · ${detail.brief.audience}` : ''}
              {detail.brief.tone ? ` · ${detail.brief.tone}` : ''}
            </p>
            <div className="tags">
              <span className="tag">
                {detail.activeVariantCount} variant{detail.activeVariantCount === 1 ? '' : 's'}
              </span>
              <span className="tag">
                {detail.variants.filter((v) => isFinished(v.status)).length} approved
              </span>
              <span className="tag">Brief revision {detail.briefRevision}</span>
            </div>
          </div>
          <Link className="btn" href={`/masters/${detail.id}`}>
            Open master →
          </Link>
        </section>
      )}

      <section className="card variant-table" aria-labelledby="all-masters">
        <div className="section-head" style={{ padding: '14px 0 0' }}>
          <div>
            <h2 id="all-masters">All masters</h2>
            <p>Each master holds a shared brief; its variants run independent productions.</p>
          </div>
        </div>
        {masters.length === 0 ? (
          <div className="empty">
            <h3>No content masters yet</h3>
            Creating content also creates its master.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Content masters">
              <thead>
                <tr>
                  <th scope="col">Master</th>
                  <th scope="col">Project</th>
                  <th scope="col">Variants</th>
                  <th scope="col">Brief</th>
                  <th scope="col">Updated</th>
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
                    <td>Revision {m.briefRevision}</td>
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
