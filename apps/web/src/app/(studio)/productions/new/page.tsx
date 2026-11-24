import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type {
  AiModelDto,
  AiRouteList,
  BudgetDto,
  Page,
  VersionedEntityDto,
  VoiceProfileListDto,
} from '@acf/contracts';

import { PageCrumbs } from '@/components/shell/page-crumbs';
import { apiGet } from '@/lib/api-server';
import { getT } from '@/lib/i18n/server';
import { writableProjects } from '@/lib/project-options';
import { loadWorkspace } from '@/lib/workspace';

import { NewContentForm, type NewContentProject } from './new-content-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('brief.title') };
}

const ready = (list: Awaited<ReturnType<typeof apiGet<Page<VersionedEntityDto>>>>) =>
  list.kind === 'ok' ? list.data.data.filter((x) => x.master !== null) : [];

/**
 * New content (redesign canvas): a full page for the brief. Loads, per writable project, the
 * approved characters and environments, voice profiles and budget, plus the task routes and the
 * enabled models' prices for the run estimate. `?project=` preselects a project.
 */
export default async function NewContentPage(props: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [workspace, routes, models, t, query] = await Promise.all([
    loadWorkspace(),
    apiGet<AiRouteList>('/ai/routes'),
    apiGet<Page<AiModelDto>>('/ai/models?status=enabled&limit=100'),
    getT(),
    props.searchParams,
  ]);
  if (workspace.kind === 'unauthenticated') redirect('/login');
  if (workspace.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('todo.loadError')}
      </section>
    );
  }
  const writable = writableProjects(workspace.data.projects);
  const projects: NewContentProject[] = await Promise.all(
    writable.map(async (p) => {
      const [characters, environments, voices, budget] = await Promise.all([
        apiGet<Page<VersionedEntityDto>>(`/projects/${p.id}/characters?limit=100`),
        apiGet<Page<VersionedEntityDto>>(`/projects/${p.id}/environments?limit=100`),
        apiGet<VoiceProfileListDto>(`/projects/${p.id}/voice-profiles`),
        apiGet<BudgetDto>(`/projects/${p.id}/budget`),
      ]);
      return {
        ...p,
        characters: ready(characters),
        environments: ready(environments),
        voiceProfiles:
          voices.kind === 'ok' ? voices.data.items.filter((v) => v.archivedAt === null) : [],
        budget: budget.kind === 'ok' ? budget.data : null,
      };
    }),
  );
  const requested = query['project'];
  return (
    <>
      <PageCrumbs
        items={[{ label: t('nav.productions'), href: '/productions' }, { label: t('brief.title') }]}
      />
      <NewContentForm
        projects={projects}
        initialProjectId={typeof requested === 'string' ? requested : (projects[0]?.id ?? '')}
        routes={routes.kind === 'ok' ? routes.data.data : []}
        models={models.kind === 'ok' ? models.data.data : []}
      />
    </>
  );
}
