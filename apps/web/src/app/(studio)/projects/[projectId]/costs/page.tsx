import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { BudgetDto, CostFigureDto, ProjectCostsDto, ProjectDto } from '@acf/contracts';

import { CostFigure } from '@/components/cost-figure';
import { ProjectTabs } from '@/components/project-tabs';
import { apiGet } from '@/lib/api-server';
import { jobKindLabel } from '@/lib/format';
import type { Translate } from '@/lib/i18n';
import { getT } from '@/lib/i18n/server';
import { formatUsd, formatUsdSummary } from '@/lib/money';

import { BudgetEditor } from './budget-editor';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('costs.pageTitle') };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function CostTable(props: {
  readonly t: Translate;
  readonly label: string;
  readonly rows: readonly {
    readonly key: string;
    readonly name: React.ReactNode;
    readonly cost: CostFigureDto;
  }[];
}) {
  const { t } = props;
  return (
    <section className="card card-pad">
      <h2>{props.label}</h2>
      {props.rows.length === 0 ? (
        <p className="muted small-text">{t('pcosts.noSpending')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label={props.label}>
            <thead>
              <tr>
                <th scope="col">{t('pcosts.colName')}</th>
                <th scope="col">{t('pcosts.colCalls')}</th>
                <th scope="col">{t('pcosts.colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}</td>
                  <td>{r.cost.calls}</td>
                  <td>
                    <CostFigure cost={r.cost} t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Costs tab of a project (M7 design §9): month total vs budget, breakdowns, trend; budget editor. */
export default async function ProjectCostsPage(props: {
  readonly params: Promise<{ projectId: string }>;
  readonly searchParams: Promise<{ month?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([props.params, props.searchParams]);
  const month = query.month && MONTH.test(query.month) ? query.month : undefined;
  const [project, budget, costs, t] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<BudgetDto>(`/projects/${projectId}/budget`),
    apiGet<ProjectCostsDto>(`/projects/${projectId}/costs${month ? `?month=${month}` : ''}`),
    getT(),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind === 'error') {
    if (project.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        {t('pcosts.projectError')}
      </section>
    );
  }
  if (budget.kind !== 'ok' || costs.kind !== 'ok') {
    return (
      <section className="card notice error" role="alert">
        {t('costs.loadError')}
      </section>
    );
  }
  const b = budget.data;
  const c = costs.data;
  const thisMonth = !month || month === b.periodStart.slice(0, 7);
  const maxTrend = c.trend.reduce((m, point) => Math.max(m, Number(point.cost.totalUsd)), 0);
  const mode = (value: 'hard' | 'soft') => t(value === 'hard' ? 'mode.hard' : 'mode.soft');
  const limit = (l: { limitUsd: string | null; mode: 'hard' | 'soft' }) =>
    l.limitUsd === null ? t('pcosts.limitNone') : `${formatUsd(l.limitUsd)} (${mode(l.mode)})`;

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href="/projects">{t('nav.projects')}</Link> /{' '}
            <Link href={`/projects/${projectId}`}>{project.data.name}</Link> / {t('nav.costs')}
          </div>
          <h1>{t('pcosts.title')}</h1>
          <p>{t('pcosts.lead', { month: c.month })}</p>
        </div>
      </div>
      <ProjectTabs projectId={projectId} />

      {b.warning && (
        <p className="notice" role="status">
          {formatUsd(b.monthly.limitUsd) === '$0'
            ? t('pcosts.zeroBudget')
            : t('pcosts.warning', { left: formatUsdSummary(b.remainingUsd) })}
        </p>
      )}

      <section className="stats" aria-label={t('pcosts.budget')}>
        <div className="card stat">
          <div className="stat-top">{t('costs.total')}</div>
          <div className="stat-value">{formatUsdSummary(c.total.totalUsd)}</div>
          <div className="stat-foot">
            {t('pcosts.ofLimit', {
              limit: formatUsd(c.budget.limitUsd),
              mode: mode(b.monthly.mode),
              calls: c.total.calls,
            })}
          </div>
        </div>
        {thisMonth && (
          <>
            <div className="card stat">
              <div className="stat-top">{t('costs.reserved')}</div>
              <div className="stat-value">{formatUsdSummary(b.reservedUsd)}</div>
              <div className="stat-foot">{t('costs.reservedFoot')}</div>
            </div>
            <div className="card stat">
              <div className="stat-top">{t('costs.held')}</div>
              <div className="stat-value">{formatUsdSummary(b.heldUsd)}</div>
              <div className="stat-foot">{t('costs.heldFoot')}</div>
            </div>
            <div className="card stat">
              <div className="stat-top">{t('pcosts.remaining')}</div>
              <div className="stat-value">{formatUsdSummary(b.remainingUsd)}</div>
              <div className="stat-foot">
                {b.unknownCalls > 0
                  ? t('costs.unknownPart', { count: b.unknownCalls })
                  : t('pcosts.thisMonth')}
              </div>
            </div>
          </>
        )}
        <div className="card stat">
          <div className="stat-top">{t('pcosts.retries')}</div>
          <div className="stat-value">{formatUsdSummary(c.retryCost.totalUsd)}</div>
          <div className="stat-foot">{t('pcosts.retriesFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('pcosts.perVideo')}</div>
          <div className="stat-value">
            {c.costPerApprovedVideo ? formatUsdSummary(c.costPerApprovedVideo.perVideoUsd) : '—'}
          </div>
          <div className="stat-foot">
            {c.costPerApprovedVideo
              ? t('pcosts.approvedThisMonth', { count: c.costPerApprovedVideo.approvedVideos })
              : t('pcosts.noneApproved')}
          </div>
        </div>
      </section>

      <section className="card card-pad" aria-label={t('pcosts.trend')}>
        <h2>{t('pcosts.lastSix')}</h2>
        <div className="chart cost-trend">
          {c.trend.map((point) => (
            <Link
              key={point.month}
              className="bar-group"
              href={`/projects/${projectId}/costs?month=${point.month}`}
            >
              <div
                className={point.month === c.month ? 'bar dark' : 'bar'}
                style={{
                  height: `${String(maxTrend > 0 ? Math.max(4, (Number(point.cost.totalUsd) / maxTrend) * 100) : 4)}%`,
                }}
                title={`${point.month}: ${formatUsd(point.cost.totalUsd)}`}
              />
              <span className="bar-label">
                {point.month} · {formatUsdSummary(point.cost.totalUsd)}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <CostTable
        t={t}
        label={t('pcosts.byItem')}
        rows={c.byContentItem.map((r) => ({
          key: r.contentItemId,
          name: <Link href={`/content/${r.contentItemId}`}>{r.title}</Link>,
          cost: r.cost,
        }))}
      />
      <CostTable
        t={t}
        label={t('pcosts.byStage')}
        rows={c.byStage.map((r) => ({
          key: r.kind,
          name: jobKindLabel(t, r.kind),
          cost: r.cost,
        }))}
      />
      <CostTable
        t={t}
        label={t('pcosts.byModel')}
        rows={c.byModel.map((r) => ({
          key: `${r.providerKey}/${r.modelKey}`,
          name: `${r.modelKey} (${r.providerKey})`,
          cost: r.cost,
        }))}
      />

      {project.data.role === 'owner' ? (
        <BudgetEditor budget={b} />
      ) : (
        <section className="card card-pad" aria-label={t('pcosts.limits')}>
          <h2>{t('pcosts.limits')}</h2>
          <p className="small-text">
            {t('pcosts.limitsText', {
              monthly: `${formatUsd(b.monthly.limitUsd)} (${mode(b.monthly.mode)})`,
              item: limit(b.item),
              request: limit(b.request),
            })}
          </p>
        </section>
      )}
    </div>
  );
}
