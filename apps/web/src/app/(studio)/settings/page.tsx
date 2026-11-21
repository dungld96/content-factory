import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type {
  AiModelDto,
  AiProviderList,
  AiRegistryEventDto,
  AiRouteList,
  MeResponse,
  Page,
  ProjectDto,
  VoiceProfileListDto,
} from '@acf/contracts';

import { ProjectSettingsForm } from '@/components/forms';
import { LocalTime } from '@/components/local-time';
import { QueryFilters } from '@/components/query-filters';
import { Pill } from '@/components/status-pill';
import { VoiceProfilesCard } from '@/components/voice-profiles';
import { routeReadiness } from '@/lib/ai-settings-view';
import { fetchApiHealth } from '@/lib/api-health';
import { apiGet } from '@/lib/api-server';
import { param, type SearchParams } from '@/lib/content-filters';
import { usableModels } from '@/lib/model-options';
import { apiGetAll } from '@/lib/workspace';

import { ActivityPanel, ModelsPanel, ProvidersPanel, RoutesPanel } from './ai-settings';
import { ImportModelsPanel } from './model-admin';
import { SectionSelect } from './section-select';

export const metadata: Metadata = { title: 'Settings · Content Studio' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

type Section = 'general' | 'voices' | 'ai' | 'models' | 'activity' | 'system';

const SECTIONS: readonly {
  readonly id: Section;
  readonly label: string;
  readonly hint: string;
  readonly operatorOnly?: boolean;
}[] = [
  { id: 'general', label: 'General', hint: 'Account and project' },
  { id: 'voices', label: 'Voice profiles', hint: 'Narration voices' },
  { id: 'ai', label: 'AI providers', hint: 'Keys and task routes' },
  { id: 'models', label: 'Models', hint: 'Catalogue and prices' },
  { id: 'activity', label: 'Change log', hint: 'Registry audit', operatorOnly: true },
  { id: 'system', label: 'System status', hint: 'Dependencies' },
];

const HEADINGS: Readonly<Record<Section, { title: string; text: string }>> = {
  general: {
    title: 'General',
    text: 'Your account and the defaults of each project.',
  },
  voices: {
    title: 'Voice profiles',
    text: 'Voices used to narrate scenes. Past voice-overs keep the voice they were made with.',
  },
  ai: {
    title: 'AI providers',
    text: 'Which providers this deployment can use, and the model each production step uses.',
  },
  models: {
    title: 'Models',
    text: 'Registered models with their limits and current prices.',
  },
  activity: {
    title: 'Change log',
    text: 'Every change to providers, models, routes and prices, from Settings or the operator CLI.',
  },
  system: {
    title: 'System status',
    text: 'The services the platform depends on, checked now.',
  },
};

function hrefFor(section: Section, projectId?: string): string {
  const query = new URLSearchParams({ section });
  if (projectId) query.set('project', projectId);
  return `/settings?${query.toString()}`;
}

export default async function SettingsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const [me, projects] = await Promise.all([
    apiGet<MeResponse>('/auth/me'),
    apiGetAll<ProjectDto>('/projects'),
  ]);
  if (me.kind === 'unauthenticated' || projects.kind === 'unauthenticated') redirect('/login');
  const isOperator = me.kind === 'ok' && me.data.isOperator;
  const visible = SECTIONS.filter((s) => !s.operatorOnly || isOperator);
  const section: Section = visible.find((s) => s.id === param(query, 'section'))?.id ?? 'general';
  const list = projects.kind === 'ok' ? projects.data.items : [];
  const selected = list.find((p) => p.id === param(query, 'project')) ?? list[0];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Settings</h1>
          <p>Account, projects, voices, AI providers and models, and the platform’s health.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {visible.map((s) => (
            <Link
              key={s.id}
              href={hrefFor(s.id, selected?.id)}
              aria-current={s.id === section ? 'page' : undefined}
            >
              <b>{s.label}</b>
              <span>{s.hint}</span>
            </Link>
          ))}
        </nav>

        <SectionSelect
          current={section}
          options={visible.map((s) => ({
            id: s.id,
            label: s.label,
            href: hrefFor(s.id, selected?.id),
          }))}
        />

        <div className="settings-main">
          <header className="settings-section-head">
            <h2>{HEADINGS[section].title}</h2>
            <p>{HEADINGS[section].text}</p>
          </header>
          {section === 'general' && (
            <GeneralSection
              me={me.kind === 'ok' ? me.data : null}
              list={list}
              selected={selected}
            />
          )}
          {section === 'voices' && <VoicesSection list={list} selected={selected} />}
          {(section === 'ai' || section === 'models' || section === 'activity') && (
            <AiSection section={section} isOperator={isOperator} />
          )}
          {section === 'system' && <SystemSection />}
        </div>
      </div>
    </>
  );
}

function ProjectSwitcher(props: { readonly list: readonly ProjectDto[] }) {
  if (props.list.length < 2) return null;
  return (
    <QueryFilters
      selects={[
        {
          name: 'project',
          label: 'Project',
          allLabel: 'First project',
          options: props.list.map((p) => ({ value: p.id, label: p.name })),
        },
      ]}
    />
  );
}

function GeneralSection(props: {
  readonly me: MeResponse | null;
  readonly list: readonly ProjectDto[];
  readonly selected: ProjectDto | undefined;
}) {
  const { me, selected } = props;
  return (
    <div className="settings-columns">
      <section className="card card-pad" aria-labelledby="account">
        <div className="section-head">
          <div>
            <h3 id="account">Account</h3>
            <p>Accounts are created and reset by an administrator.</p>
          </div>
          {me?.isOperator && <Pill tone="purple">Platform operator</Pill>}
        </div>
        {me ? (
          <dl className="kv">
            <dt>Name</dt>
            <dd>{me.user.displayName}</dd>
            <dt>Email</dt>
            <dd>{me.user.email}</dd>
            <dt>Projects</dt>
            <dd>
              {me.memberships.length === 0 ? (
                'None'
              ) : (
                <ul className="role-list">
                  {me.memberships.map((m) => (
                    <li key={m.projectId}>
                      <Link href={`/projects/${m.projectId}`}>{m.projectName}</Link>
                      <span className="tag">{ROLE_LABEL[m.role]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        ) : (
          <p className="notice error">The account could not be loaded.</p>
        )}
      </section>

      <section className="card card-pad" aria-labelledby="project-settings">
        <div className="section-head">
          <div>
            <h3 id="project-settings">Project profile</h3>
            <p>Name, default language and timezone of new content. Owners can change them.</p>
          </div>
        </div>
        <ProjectSwitcher list={props.list} />
        {!selected ? (
          <p className="muted small-text">You are not a member of any project.</p>
        ) : selected.role === 'owner' && selected.archivedAt === null ? (
          <ProjectSettingsForm project={selected} />
        ) : (
          <dl className="kv">
            <dt>Project</dt>
            <dd>
              <Link href={`/projects/${selected.id}`}>{selected.name}</Link>
            </dd>
            <dt>Your role</dt>
            <dd>{ROLE_LABEL[selected.role]}</dd>
            <dt>Default language</dt>
            <dd>{selected.defaultLanguage}</dd>
            <dt>Timezone</dt>
            <dd>{selected.timezone}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}

async function VoicesSection(props: {
  readonly list: readonly ProjectDto[];
  readonly selected: ProjectDto | undefined;
}) {
  const { selected } = props;
  if (!selected) {
    return <p className="muted small-text">You are not a member of any project.</p>;
  }
  const [profiles, models, providers] = await Promise.all([
    apiGet<VoiceProfileListDto>(`/projects/${selected.id}/voice-profiles`),
    apiGet<Page<AiModelDto>>('/ai/models?capability=tts&limit=100'),
    apiGet<AiProviderList>('/ai/providers'),
  ]);
  const usable = new Set(
    usableModels(
      models.kind === 'ok' ? models.data.data : [],
      providers.kind === 'ok' ? providers.data.data : [],
    ).map((m) => m.id),
  );
  const ttsModels =
    models.kind === 'ok'
      ? models.data.data.map((m) => ({
          modelKey: m.modelKey,
          label: `${m.displayName} (${m.modelKey})`,
          enabled: usable.has(m.id),
          voices: m.voices ?? [],
        }))
      : [];
  return (
    <section className="card card-pad" aria-labelledby="voice-profiles">
      <div className="section-head">
        <div>
          <h3 id="voice-profiles">Voices in {selected.name}</h3>
          <p>Editors create and change them; only speech models that can run are offered.</p>
        </div>
      </div>
      <ProjectSwitcher list={props.list} />
      {profiles.kind === 'ok' ? (
        <VoiceProfilesCard
          projectId={selected.id}
          profiles={profiles.data.items}
          models={ttsModels}
          canEdit={selected.role !== 'viewer' && selected.archivedAt === null}
        />
      ) : (
        <p className="notice error">The voice profiles could not be loaded.</p>
      )}
    </section>
  );
}

async function AiSection(props: {
  readonly section: 'ai' | 'models' | 'activity';
  readonly isOperator: boolean;
}) {
  const [providers, routes, models, events] = await Promise.all([
    apiGet<AiProviderList>('/ai/providers'),
    apiGet<AiRouteList>('/ai/routes'),
    apiGet<Page<AiModelDto>>('/ai/models?limit=100'),
    props.isOperator && props.section === 'activity'
      ? apiGet<Page<AiRegistryEventDto>>('/ai/registry-events?limit=50')
      : Promise.resolve(null),
  ]);
  if (providers.kind !== 'ok' || routes.kind !== 'ok' || models.kind !== 'ok') {
    return (
      <p className="notice error">The AI settings could not be loaded. Reload to try again.</p>
    );
  }
  const providerList = providers.data.data;
  const modelList = models.data.data;
  const ready = routes.data.data.filter((r) => routeReadiness(r, providerList).ready).length;

  return (
    <>
      {!props.isOperator && (
        <p className="notice" role="note">
          You can view these settings. Changes are made by platform operators (listed in the
          server’s <code>OPERATOR_EMAILS</code>).
        </p>
      )}
      {props.section === 'ai' && (
        <>
          <section className="stats settings-stats" aria-label="AI summary">
            <div className="card stat">
              <div className="stat-top">Providers enabled</div>
              <div className="stat-value">
                {providerList.filter((p) => p.status === 'enabled').length}/{providerList.length}
              </div>
              <div className="stat-foot">
                {providerList.filter((p) => p.configured).length} with credentials
              </div>
            </div>
            <div className="card stat">
              <div className="stat-top">Task routes ready</div>
              <div className="stat-value">
                {ready}/{routes.data.data.length}
              </div>
              <div className="stat-foot">
                {ready === routes.data.data.length ? 'Every step can run' : 'Some steps cannot run'}
              </div>
            </div>
            <div className="card stat">
              <div className="stat-top">Models enabled</div>
              <div className="stat-value">
                {modelList.filter((m) => m.status === 'enabled').length}/{modelList.length}
              </div>
              <div className="stat-foot">
                <Link href="/settings?section=models">Open the catalogue</Link>
              </div>
            </div>
          </section>
          <ProvidersPanel providers={providerList} isOperator={props.isOperator} />
          <RoutesPanel
            routes={routes.data.data}
            providers={providerList}
            models={usableModels(modelList, providerList)}
            isOperator={props.isOperator}
          />
        </>
      )}
      {props.section === 'models' && (
        <>
          {props.isOperator && <ImportModelsPanel />}
          <ModelsPanel models={modelList} providers={providerList} isOperator={props.isOperator} />
        </>
      )}
      {props.section === 'activity' && (
        <ActivityPanel events={events?.kind === 'ok' ? events.data.data : []} />
      )}
    </>
  );
}

async function SystemSection() {
  const health = await fetchApiHealth();
  return (
    <section className="card card-pad" aria-labelledby="system">
      <div className="section-head">
        <div>
          <h3 id="system">Dependencies</h3>
          <p>
            Checked when this page loaded. Public page: <Link href="/status">system status</Link>.
          </p>
        </div>
        {health.kind === 'ok' ? (
          <Pill tone="green">Operational</Pill>
        ) : health.kind === 'degraded' ? (
          <Pill tone="amber">Degraded</Pill>
        ) : (
          <Pill tone="red">API unreachable</Pill>
        )}
      </div>
      {health.kind === 'unreachable' ? (
        <p className="notice error">{health.reason}.</p>
      ) : (
        <>
          <ul className="health-tiles" aria-label="Dependencies">
            {Object.entries(health.data.checks).map(([name, check]) => (
              <li key={name} className={check.status === 'ok' ? 'ok' : 'bad'}>
                <span className="health-name">
                  {name === 'redis' ? 'Queue (Redis)' : name === 'database' ? 'Database' : name}
                </span>
                <Pill tone={check.status === 'ok' ? 'green' : 'red'}>
                  {check.status === 'ok' ? 'OK' : (check.error ?? 'error')}
                </Pill>
                <span className="muted small-text">{check.latencyMs} ms</span>
              </li>
            ))}
          </ul>
          <p className="muted small-text">
            Checked at <LocalTime iso={health.data.timestamp} />.
          </p>
        </>
      )}
    </section>
  );
}
