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
import { fetchApiHealth } from '@/lib/api-health';
import { apiGet } from '@/lib/api-server';
import { param, type SearchParams } from '@/lib/content-filters';
import { usableModels } from '@/lib/model-options';
import { apiGetAll } from '@/lib/workspace';

import { AiSettings } from './ai-settings';

export const metadata: Metadata = { title: 'Settings · Content Studio' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

export default async function SettingsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const [me, projects, health, providers, routes, allModels] = await Promise.all([
    apiGet<MeResponse>('/auth/me'),
    apiGetAll<ProjectDto>('/projects'),
    fetchApiHealth(),
    apiGet<AiProviderList>('/ai/providers'),
    apiGet<AiRouteList>('/ai/routes'),
    apiGet<Page<AiModelDto>>('/ai/models?limit=100'),
  ]);
  if (me.kind === 'unauthenticated' || projects.kind === 'unauthenticated') redirect('/login');
  const isOperator = me.kind === 'ok' && me.data.isOperator;
  const events = isOperator
    ? await apiGet<Page<AiRegistryEventDto>>('/ai/registry-events?limit=20')
    : null;
  const providerList = providers.kind === 'ok' ? providers.data.data : [];
  const modelList = allModels.kind === 'ok' ? allModels.data.data : [];
  const list = projects.kind === 'ok' ? projects.data.items : [];
  const selected = list.find((p) => p.id === param(query, 'project')) ?? list[0];
  const [profiles, models] = selected
    ? await Promise.all([
        apiGet<VoiceProfileListDto>(`/projects/${selected.id}/voice-profiles`),
        apiGet<Page<AiModelDto>>('/ai/models?capability=tts&limit=100'),
      ])
    : [null, null];
  const usableTts = new Set(
    usableModels(models?.kind === 'ok' ? models.data.data : [], providerList).map((m) => m.id),
  );
  const ttsModels =
    models?.kind === 'ok'
      ? models.data.data.map((m) => ({
          modelKey: m.modelKey,
          label: `${m.displayName} (${m.modelKey})`,
          enabled: usableTts.has(m.id),
          voices: m.voices ?? [],
        }))
      : [];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Settings</h1>
          <p>Your account, project defaults, AI providers and models, and the platform’s health.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="card card-pad" aria-labelledby="account">
          <div className="section-head">
            <div>
              <h2 id="account">Account</h2>
              <p>Accounts are managed by an administrator.</p>
            </div>
          </div>
          {me.kind === 'ok' ? (
            <dl className="kv">
              <dt>Name</dt>
              <dd>{me.data.user.displayName}</dd>
              <dt>Email</dt>
              <dd>{me.data.user.email}</dd>
              <dt>Projects</dt>
              <dd>
                {me.data.memberships
                  .map((m) => `${m.projectName} (${ROLE_LABEL[m.role]})`)
                  .join(', ') || 'None'}
              </dd>
            </dl>
          ) : (
            <p className="notice error">The account could not be loaded.</p>
          )}
        </section>

        <section className="card card-pad" aria-labelledby="project-settings">
          <div className="section-head">
            <div>
              <h2 id="project-settings">Project profile</h2>
              <p>
                Name, default language and timezone of new content. Only owners can change them.
              </p>
            </div>
          </div>
          {!selected ? (
            <p className="muted small-text">You are not a member of any project.</p>
          ) : (
            <>
              {list.length > 1 && (
                <QueryFilters
                  selects={[
                    {
                      name: 'project',
                      label: 'Project',
                      allLabel: 'First project',
                      options: list.map((p) => ({ value: p.id, label: p.name })),
                    },
                  ]}
                />
              )}
              {selected.role === 'owner' && selected.archivedAt === null ? (
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
            </>
          )}
        </section>

        {selected && (
          <section className="card card-pad" aria-labelledby="voice-profiles">
            <div className="section-head">
              <div>
                <h2 id="voice-profiles">Voice profiles</h2>
                <p>
                  Voices for scene voice-overs in {selected.name}. Editors manage them; past
                  voice-overs keep the voice they were made with.
                </p>
              </div>
            </div>
            {profiles?.kind === 'ok' ? (
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
        )}

        {providers.kind === 'ok' && routes.kind === 'ok' ? (
          <AiSettings
            providers={providerList}
            routes={routes.data.data}
            models={modelList}
            events={events?.kind === 'ok' ? events.data.data : []}
            isOperator={isOperator}
          />
        ) : (
          <p className="notice error">The AI settings could not be loaded.</p>
        )}

        <section className="card card-pad" aria-labelledby="system">
          <div className="section-head">
            <div>
              <h2 id="system">System status</h2>
              <p>Dependencies the API needs (checked now).</p>
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
              <dl className="kv">
                {Object.entries(health.data.checks).map(([name, check]) => (
                  <div key={name} style={{ display: 'contents' }}>
                    <dt>{name}</dt>
                    <dd>
                      {check.status === 'ok' ? 'ok' : (check.error ?? 'error')} · {check.latencyMs}{' '}
                      ms
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="muted small-text">
                Checked at <LocalTime iso={health.data.timestamp} />. Public page:{' '}
                <Link href="/status">system status</Link>.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
