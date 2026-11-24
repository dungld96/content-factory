import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { Page, ProjectDto, VersionedEntityDto } from '@acf/contracts';

import { ProjectTabs } from '@/components/project-tabs';
import { apiGet } from '@/lib/api-server';
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
  const [project, characters, environments, t] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<Page<VersionedEntityDto>>(`/projects/${projectId}/characters?limit=100`),
    apiGet<Page<VersionedEntityDto>>(`/projects/${projectId}/environments?limit=100`),
    getT(),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind !== 'ok') notFound();
  const canEdit = project.data.role !== 'viewer' && project.data.archivedAt === null;
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
        entities={characters.kind === 'ok' ? characters.data.data : []}
        canEdit={canEdit}
      />
      <BrandSection
        kind="environments"
        projectId={projectId}
        entities={environments.kind === 'ok' ? environments.data.data : []}
        canEdit={canEdit}
      />
    </>
  );
}
