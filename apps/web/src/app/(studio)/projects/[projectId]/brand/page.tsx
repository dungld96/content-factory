import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { Page, ProjectDto, VersionedEntityDto } from '@acf/contracts';

import { apiGet } from '@/lib/api-server';

import { BrandSection } from './brand-section';

export const metadata: Metadata = { title: 'Characters & environments · Content Studio' };
export const dynamic = 'force-dynamic';

/**
 * Recurring characters and environments of a project (P2b design L3) with their versions; each
 * version links reference assets chosen from the Asset library. Approving a draft makes it the
 * master used by new storyboards.
 */
export default async function BrandPage(props: {
  readonly params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  const [project, characters, environments] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<Page<VersionedEntityDto>>(`/projects/${projectId}/characters?limit=100`),
    apiGet<Page<VersionedEntityDto>>(`/projects/${projectId}/environments?limit=100`),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind !== 'ok') notFound();
  const canEdit = project.data.role !== 'viewer' && project.data.archivedAt === null;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href={`/projects/${projectId}`}>{project.data.name}</Link> / Brand
          </div>
          <h1>Characters &amp; environments</h1>
          <p>
            Recurring people and places. Each version links reference images from the{' '}
            <Link href={`/assets?project=${projectId}`}>Asset library</Link>; approved versions
            never change, and storyboards keep the version they were made with.
          </p>
        </div>
      </div>
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
