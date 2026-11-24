import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Fragment } from 'react';

import type {
  AiModelDto,
  AiProviderList,
  AiRegistryEventDto,
  AiRouteList,
  BudgetDto,
  MeResponse,
  Page,
  ProjectDto,
  SpendingSettingsDto,
  VoiceProfileListDto,
} from '@acf/contracts';

import { ProjectSettingsForm } from '@/components/forms';
import { Icon, type IconName } from '@/components/icon';
import { LocalTime } from '@/components/local-time';
import { QueryFilters } from '@/components/query-filters';
import { PageCrumbs } from '@/components/shell/page-crumbs';
import { Pill } from '@/components/status-pill';
import { VoiceProfilesCard } from '@/components/voice-profiles';
import { routeReadiness } from '@/lib/ai-settings-view';
import { fetchApiHealth } from '@/lib/api-health';
import { apiGet } from '@/lib/api-server';
import { param, type SearchParams } from '@/lib/content-filters';
import type { MessageKey, Translate } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';
import { usableModels } from '@/lib/model-options';
import { formatUsd } from '@/lib/money';
import { apiGetAll } from '@/lib/workspace';

import { ActivityPanel, ModelsPanel, ProvidersPanel, RoutesPanel } from '../ai-settings';
import { ImportModelsPanel } from '../model-admin';
import { ProfileLanguage } from '../profile-language';
import { SectionSelect } from '../section-select';
import { SpendingForm } from '../spending-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('set.pageTitle') };
}

const ROLE_LABEL = { owner: 'role.owner', editor: 'role.editor', viewer: 'role.viewer' } as const;

const SECTIONS = [
  'general',
  'profile',
  'budgets',
  'voices',
  'ai',
  'models',
  'activity',
  'system',
] as const;
type Section = (typeof SECTIONS)[number];
const OPERATOR_ONLY: ReadonlySet<Section> = new Set(['activity']);

const label = (s: Section): MessageKey => `set.s.${s}`;

/** Menu groups of the canvas: Workspace, AI, System. */
const GROUPS: readonly {
  readonly id: 'workspace' | 'ai' | 'system';
  readonly sections: readonly Section[];
}[] = [
  { id: 'workspace', sections: ['general', 'profile', 'budgets', 'voices'] },
  { id: 'ai', sections: ['ai', 'models'] },
  { id: 'system', sections: ['activity', 'system'] },
];

const SECTION_ICON: Readonly<Record<Section, IconName>> = {
  general: 'folder',
  profile: 'language',
  budgets: 'costs',
  voices: 'mic',
  ai: 'generate',
  models: 'dollar',
  activity: 'history',
  system: 'operations',
};

function hrefFor(section: Section, projectId?: string): string {
  return projectId ? `/settings/${section}?project=${projectId}` : `/settings/${section}`;
}

/** Settings as sub-routes (redesign R6): `/settings/<section>`, one section per page. */
export default async function SettingsSectionPage(props: {
  readonly params: Promise<{ section: string }>;
  readonly searchParams: Promise<SearchParams>;
}) {
  const [{ section: raw }, query, me, projects, t] = await Promise.all([
    props.params,
    props.searchParams,
    getMe(),
    apiGetAll<ProjectDto>('/projects'),
    getT(),
  ]);
  if (me.kind === 'unauthenticated' || projects.kind === 'unauthenticated') redirect('/login');
  const isOperator = me.kind === 'ok' && me.data.isOperator;
  const visible = SECTIONS.filter((s) => !OPERATOR_ONLY.has(s) || isOperator);
  const section = visible.find((s) => s === raw);
  if (!section) notFound();
  const list = projects.kind === 'ok' ? projects.data.items : [];
  const selected = list.find((p) => p.id === param(query, 'project')) ?? list[0];

  return (
    <>
      <PageCrumbs
        items={[{ label: t('set.title'), href: '/settings' }, { label: t(label(section)) }]}
      />
      <div className="settings-layout">
        <nav className="col settings-nav" aria-label={t('set.sections')}>
          {GROUPS.map((group) => {
            const items = group.sections.filter((s) => visible.includes(s));
            if (items.length === 0) return null;
            return (
              <Fragment key={group.id}>
                <span className="eyebrow">{t(`set.group.${group.id}`)}</span>
                {items.map((s) => (
                  <Link
                    key={s}
                    className={s === section ? 'snav on' : 'snav'}
                    href={hrefFor(s, selected?.id)}
                    aria-current={s === section ? 'page' : undefined}
                  >
                    <Icon name={SECTION_ICON[s]} />
                    {t(label(s))}
                  </Link>
                ))}
              </Fragment>
            );
          })}
        </nav>

        <SectionSelect
          current={section}
          options={visible.map((s) => ({
            id: s,
            label: t(label(s)),
            href: hrefFor(s, selected?.id),
          }))}
        />

        <div className="col settings-main">
          <div className="page-head">
            <div>
              <h1>{t(label(section))}</h1>
              <p>{t(`set.s.${section}.text`)}</p>
            </div>
          </div>
          {section === 'general' && (
            <GeneralSection
              t={t}
              me={me.kind === 'ok' ? me.data : null}
              list={list}
              selected={selected}
            />
          )}
          {section === 'profile' && (
            <ProfileLanguage saved={me.kind === 'ok' ? me.data.locale : null} />
          )}
          {section === 'budgets' && <BudgetsSection t={t} list={list} isOperator={isOperator} />}
          {section === 'voices' && <VoicesSection t={t} list={list} selected={selected} />}
          {(section === 'ai' || section === 'models' || section === 'activity') && (
            <AiSection t={t} section={section} isOperator={isOperator} />
          )}
          {section === 'system' && <SystemSection t={t} />}
        </div>
      </div>
    </>
  );
}

function ProjectSwitcher(props: { readonly t: Translate; readonly list: readonly ProjectDto[] }) {
  if (props.list.length < 2) return null;
  return (
    <QueryFilters
      selects={[
        {
          name: 'project',
          label: props.t('set.project'),
          allLabel: props.t('set.firstProject'),
          options: props.list.map((p) => ({ value: p.id, label: p.name })),
        },
      ]}
    />
  );
}

function GeneralSection(props: {
  readonly t: Translate;
  readonly me: MeResponse | null;
  readonly list: readonly ProjectDto[];
  readonly selected: ProjectDto | undefined;
}) {
  const { me, selected, t } = props;
  return (
    <div className="settings-columns">
      <section className="card card-pad" aria-labelledby="account">
        <div className="section-head">
          <div>
            <h3 id="account">{t('set.account')}</h3>
            <p>{t('set.accountHint')}</p>
          </div>
          {me?.isOperator && <Pill tone="purple">{t('set.operator')}</Pill>}
        </div>
        {me ? (
          <dl className="kv">
            <dt>{t('set.name')}</dt>
            <dd>{me.user.displayName}</dd>
            <dt>{t('set.email')}</dt>
            <dd>{me.user.email}</dd>
            <dt>{t('set.projects')}</dt>
            <dd>
              {me.memberships.length === 0 ? (
                t('common.none')
              ) : (
                <ul className="role-list">
                  {me.memberships.map((m) => (
                    <li key={m.projectId}>
                      <Link href={`/projects/${m.projectId}`}>{m.projectName}</Link>
                      <span className="tag">{t(ROLE_LABEL[m.role])}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        ) : (
          <p className="notice error">{t('set.accountError')}</p>
        )}
      </section>

      <section className="card card-pad" aria-labelledby="project-settings">
        <div className="section-head">
          <div>
            <h3 id="project-settings">{t('set.projectProfile')}</h3>
            <p>{t('set.projectProfileHint')}</p>
          </div>
        </div>
        <ProjectSwitcher t={t} list={props.list} />
        {!selected ? (
          <p className="muted small-text">{t('set.noProject')}</p>
        ) : selected.role === 'owner' && selected.archivedAt === null ? (
          <ProjectSettingsForm project={selected} />
        ) : (
          <dl className="kv">
            <dt>{t('set.project')}</dt>
            <dd>
              <Link href={`/projects/${selected.id}`}>{selected.name}</Link>
            </dd>
            <dt>{t('set.yourRole')}</dt>
            <dd>{t(ROLE_LABEL[selected.role])}</dd>
            <dt>{t('set.defaultLanguage')}</dt>
            <dd>{selected.defaultLanguage}</dd>
            <dt>{t('set.timezone')}</dt>
            <dd>{selected.timezone}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}

async function BudgetsSection(props: {
  readonly t: Translate;
  readonly list: readonly ProjectDto[];
  readonly isOperator: boolean;
}) {
  const { t } = props;
  const [spending, ...budgets] = await Promise.all([
    apiGet<SpendingSettingsDto>('/settings/spending'),
    ...props.list.map((p) => apiGet<BudgetDto>(`/projects/${p.id}/budget`)),
  ]);
  if (spending.kind !== 'ok') {
    return <p className="notice error">{t('set.thresholdError')}</p>;
  }
  const workspace = spending.data.confirmThresholdUsd;
  return (
    <div className="settings-columns">
      <section className="card card-pad" aria-labelledby="threshold">
        <div className="section-head">
          <div>
            <h3 id="threshold">{t('set.threshold')}</h3>
            <p>{t('set.thresholdHint')}</p>
          </div>
        </div>
        <SpendingForm thresholdUsd={workspace} canEdit={props.isOperator} />
      </section>
      <section className="card card-pad" aria-labelledby="overrides">
        <div className="section-head">
          <div>
            <h3 id="overrides">{t('set.projectOverrides')}</h3>
            <p>{t('set.projectOverridesHint')}</p>
          </div>
        </div>
        {props.list.length === 0 ? (
          <p className="muted small-text">{t('set.noProject')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label={t('set.projectOverrides')}>
              <thead>
                <tr>
                  <th scope="col">{t('set.colProject')}</th>
                  <th scope="col">{t('set.colThreshold')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('set.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {props.list.map((p, i) => {
                  const b = budgets[i];
                  const override = b?.kind === 'ok' ? b.data.confirmThresholdUsd : null;
                  return (
                    <tr key={p.id}>
                      <td className="table-title">{p.name}</td>
                      <td>
                        {override === null
                          ? t('set.workspaceDefault', { amount: formatUsd(workspace) })
                          : t('set.override', { amount: formatUsd(override) })}
                      </td>
                      <td>
                        {p.role === 'owner' && (
                          <Link className="link" href={`/projects/${p.id}/costs#budget-limits`}>
                            {t('set.edit')}
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

async function VoicesSection(props: {
  readonly t: Translate;
  readonly list: readonly ProjectDto[];
  readonly selected: ProjectDto | undefined;
}) {
  const { selected, t } = props;
  if (!selected) {
    return <p className="muted small-text">{t('set.noProject')}</p>;
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
          <h3 id="voice-profiles">{t('set.voicesIn', { project: selected.name })}</h3>
          <p>{t('set.voicesHint')}</p>
        </div>
      </div>
      <ProjectSwitcher t={t} list={props.list} />
      {profiles.kind === 'ok' ? (
        <VoiceProfilesCard
          projectId={selected.id}
          profiles={profiles.data.items}
          models={ttsModels}
          canEdit={selected.role !== 'viewer' && selected.archivedAt === null}
        />
      ) : (
        <p className="notice error">{t('set.voicesError')}</p>
      )}
    </section>
  );
}

async function AiSection(props: {
  readonly t: Translate;
  readonly section: 'ai' | 'models' | 'activity';
  readonly isOperator: boolean;
}) {
  const { t } = props;
  const [providers, routes, models, events] = await Promise.all([
    apiGet<AiProviderList>('/ai/providers'),
    apiGet<AiRouteList>('/ai/routes'),
    apiGet<Page<AiModelDto>>('/ai/models?limit=100'),
    props.isOperator && props.section === 'activity'
      ? apiGet<Page<AiRegistryEventDto>>('/ai/registry-events?limit=50')
      : Promise.resolve(null),
  ]);
  if (providers.kind !== 'ok' || routes.kind !== 'ok' || models.kind !== 'ok') {
    return <p className="notice error">{t('set.aiError')}</p>;
  }
  const providerList = providers.data.data;
  const modelList = models.data.data;
  const ready = routes.data.data.filter((r) => routeReadiness(r, providerList).ready).length;

  return (
    <>
      {!props.isOperator && (
        <p className="notice" role="note">
          {t('set.viewOnly')}
        </p>
      )}
      {props.section === 'ai' && (
        <>
          <section className="stats settings-stats" aria-label={t('set.aiSummary')}>
            <div className="card stat">
              <div className="stat-top">{t('set.providersEnabled')}</div>
              <div className="stat-value">
                {providerList.filter((p) => p.status === 'enabled').length}/{providerList.length}
              </div>
              <div className="stat-foot">
                {t('set.withCredentials', {
                  count: providerList.filter((p) => p.configured).length,
                })}
              </div>
            </div>
            <div className="card stat">
              <div className="stat-top">{t('set.routesReady')}</div>
              <div className="stat-value">
                {ready}/{routes.data.data.length}
              </div>
              <div className="stat-foot">
                {ready === routes.data.data.length ? t('set.everyStep') : t('set.someSteps')}
              </div>
            </div>
            <div className="card stat">
              <div className="stat-top">{t('set.modelsEnabled')}</div>
              <div className="stat-value">
                {modelList.filter((m) => m.status === 'enabled').length}/{modelList.length}
              </div>
              <div className="stat-foot">
                <Link href="/settings/models">{t('set.openCatalogue')}</Link>
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

async function SystemSection({ t }: { readonly t: Translate }) {
  const health = await fetchApiHealth();
  return (
    <section className="card card-pad" aria-labelledby="system">
      <div className="section-head">
        <div>
          <h3 id="system">{t('set.dependencies')}</h3>
          <p>
            {t('set.dependenciesHint')} <Link href="/status">{t('sys.title')}</Link>.
          </p>
        </div>
        {health.kind === 'ok' ? (
          <Pill tone="green">{t('sys.ok')}</Pill>
        ) : health.kind === 'degraded' ? (
          <Pill tone="amber">{t('sys.degraded')}</Pill>
        ) : (
          <Pill tone="red">{t('sys.unreachable')}</Pill>
        )}
      </div>
      {health.kind === 'unreachable' ? (
        <p className="notice error">{health.reason}.</p>
      ) : (
        <>
          <ul className="health-tiles" aria-label={t('set.dependencies')}>
            {Object.entries(health.data.checks).map(([name, check]) => (
              <li key={name} className={check.status === 'ok' ? 'ok' : 'bad'}>
                <span className="health-name">
                  {name === 'redis'
                    ? t('set.queueRedis')
                    : name === 'database'
                      ? t('set.database')
                      : name}
                </span>
                <Pill tone={check.status === 'ok' ? 'green' : 'red'}>
                  {check.status === 'ok' ? t('set.ok') : (check.error ?? t('sys.error'))}
                </Pill>
                <span className="muted small-text">{check.latencyMs} ms</span>
              </li>
            ))}
          </ul>
          <p className="muted small-text">
            {t('set.checkedAt')} <LocalTime iso={health.data.timestamp} />.
          </p>
        </>
      )}
    </section>
  );
}
