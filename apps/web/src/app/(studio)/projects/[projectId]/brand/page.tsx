import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { ChannelDto, Page, ProjectDto, VersionedEntityDto } from '@acf/contracts';

import { ArchiveAction } from '@/components/archive-action';
import { ProjectTabs } from '@/components/project-tabs';
import { Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { platformLabel } from '@/lib/format';
import { getT } from '@/lib/i18n/server';

import { BrandSection } from './brand-section';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('brand.pageTitle') };
}

/**
 * Recurring characters and environments of a project (P2b design L3) with their versions; each
 * version links reference assets chosen from the Asset library. Approving a draft makes it the
 * master used by new storyboards.
 */
export default async function BrandPage(props: {
  readonly params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  // Archived rows are listed too (last, marked), so they can be restored.
  const [project, characters, environments, channels, t] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<Page<VersionedEntityDto>>(
      `/projects/${projectId}/characters?limit=100&includeArchived=true`,
    ),
    apiGet<Page<VersionedEntityDto>>(
      `/projects/${projectId}/environments?limit=100&includeArchived=true`,
    ),
    apiGet<Page<ChannelDto>>(`/projects/${projectId}/channels?limit=100&includeArchived=true`),
    getT(),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind !== 'ok') notFound();
  const canEdit = project.data.role !== 'viewer' && project.data.archivedAt === null;
  const activeFirst = <T extends { readonly archivedAt: string | null }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null));
  const channelRows = channels.kind === 'ok' ? activeFirst(channels.data.data) : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href="/projects">{t('nav.projects')}</Link> /{' '}
            <Link href={`/projects/${projectId}`}>{project.data.name}</Link> / {t('brand.crumb')}
          </div>
          <h1>{t('brand.title')}</h1>
          <p>{t('brand.lead')}</p>
        </div>
      </div>
      <ProjectTabs projectId={projectId} />
      <BrandSection
        kind="characters"
        projectId={projectId}
        entities={characters.kind === 'ok' ? activeFirst(characters.data.data) : []}
        canEdit={canEdit}
        canManage={canEdit}
      />
      <BrandSection
        kind="environments"
        projectId={projectId}
        entities={environments.kind === 'ok' ? activeFirst(environments.data.data) : []}
        canEdit={canEdit}
        canManage={canEdit}
      />
      <section className="card card-pad" aria-labelledby="brand-channels">
        <div className="section-head">
          <div>
            <h2 id="brand-channels">{t('brand.channels')}</h2>
            <p>{t('brand.channelsHint')}</p>
          </div>
        </div>
        {channelRows.length === 0 ? (
          <p className="muted small-text">{t('brand.noChannel')}</p>
        ) : (
          <ul className="plain-list" aria-label={t('brand.channels')}>
            {channelRows.map((c) => (
              <li key={c.id} className="job-row">
                <span className="channel-row">
                  <b>{c.name}</b> <code>{c.slug}</code> · {platformLabel(t, c.platform)}
                  {c.handle ? ` · ${c.handle}` : ''}{' '}
                  {c.archivedAt && <Pill tone="gray">{t('projects.archived')}</Pill>}
                </span>
                {canEdit && (
                  <div className="row-actions">
                    <ArchiveAction
                      kind="channel"
                      path={`/channels/${c.id}`}
                      name={c.name}
                      archived={c.archivedAt !== null}
                      small
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
