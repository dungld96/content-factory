import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { MeResponse, ProjectDto } from '@acf/contracts';

import { ProjectSettingsForm } from '@/components/forms';
import { LocalTime } from '@/components/local-time';
import { QueryFilters } from '@/components/query-filters';
import { Pill } from '@/components/status-pill';
import { fetchApiHealth } from '@/lib/api-health';
import { apiGet } from '@/lib/api-server';
import { param, type SearchParams } from '@/lib/content-filters';
import { apiGetAll } from '@/lib/workspace';

export const metadata: Metadata = { title: 'Settings · Content Studio' };
export const dynamic = 'force-dynamic';

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

export default async function SettingsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const [me, projects, health] = await Promise.all([
    apiGet<MeResponse>('/auth/me'),
    apiGetAll<ProjectDto>('/projects'),
    fetchApiHealth(),
  ]);
  if (me.kind === 'unauthenticated' || projects.kind === 'unauthenticated') redirect('/login');
  const list = projects.kind === 'ok' ? projects.data.items : [];
  const selected = list.find((p) => p.id === param(query, 'project')) ?? list[0];

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Settings</h1>
          <p>Your account, project defaults and the platform’s health.</p>
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
