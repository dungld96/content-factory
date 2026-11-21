import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { BudgetDto, CostFigureDto, ProjectCostsDto, ProjectDto } from '@acf/contracts';

import { apiGet } from '@/lib/api-server';
import { formatUsd } from '@/lib/money';

import { BudgetEditor } from './budget-editor';

export const metadata: Metadata = { title: 'Costs · Content Studio' };
export const dynamic = 'force-dynamic';

const STAGE_LABEL: Readonly<Record<string, string>> = {
  script_generation: 'Script',
  storyboard_generation: 'Storyboard',
  image_generation: 'Images',
  video_generation: 'Clips',
  tts_generation: 'Voice-overs',
  render: 'Render',
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Reported, estimated, unknown and held kept apart (B9): unknown cost is never shown as $0. */
function Figure({ cost }: { readonly cost: CostFigureDto }) {
  const parts = [`${formatUsd(cost.reportedUsd)} reported`];
  if (cost.estimatedUsd !== '0') parts.push(`${formatUsd(cost.estimatedUsd)} estimated`);
  if (cost.heldUsd !== '0') parts.push(`${formatUsd(cost.heldUsd)} held`);
  if (cost.unknownCalls > 0) parts.push(`${String(cost.unknownCalls)} call(s) of unknown cost`);
  return (
    <>
      <b>{formatUsd(cost.totalUsd)}</b>
      <span className="muted small-text"> · {parts.join(' · ')}</span>
    </>
  );
}

function CostTable(props: {
  readonly label: string;
  readonly rows: readonly {
    readonly key: string;
    readonly name: React.ReactNode;
    readonly cost: CostFigureDto;
  }[];
}) {
  return (
    <section className="card card-pad">
      <h2>{props.label}</h2>
      {props.rows.length === 0 ? (
        <p className="muted small-text">No spending this month.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label={props.label}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}</td>
                  <td>{r.cost.calls}</td>
                  <td>
                    <Figure cost={r.cost} />
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
  const [project, budget, costs] = await Promise.all([
    apiGet<ProjectDto>(`/projects/${projectId}`),
    apiGet<BudgetDto>(`/projects/${projectId}/budget`),
    apiGet<ProjectCostsDto>(`/projects/${projectId}/costs${month ? `?month=${month}` : ''}`),
  ]);
  if (project.kind === 'unauthenticated') redirect('/login');
  if (project.kind === 'error') {
    if (project.status === 404) notFound();
    return (
      <section className="card notice error" role="alert">
        The project could not be loaded.
      </section>
    );
  }
  if (budget.kind !== 'ok' || costs.kind !== 'ok') {
    return (
      <section className="card notice error" role="alert">
        Costs could not be loaded.
      </section>
    );
  }
  const b = budget.data;
  const c = costs.data;
  const thisMonth = !month || month === b.periodStart.slice(0, 7);
  const maxTrend = c.trend.reduce((m, t) => Math.max(m, Number(t.cost.totalUsd)), 0);

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <Link href="/projects">Projects</Link> /{' '}
            <Link href={`/projects/${projectId}`}>{project.data.name}</Link> / Costs
          </div>
          <h1>Costs and budget</h1>
          <p>
            Spending of {c.month} (UTC). Every figure keeps provider-reported and estimated cost
            apart.
          </p>
        </div>
      </div>

      {b.warning && (
        <p className="notice" role="status">
          {formatUsd(b.monthly.limitUsd) === '$0'
            ? 'The monthly budget is $0: paid work is blocked.'
            : `80 % or more of this month's budget is used or reserved (${formatUsd(b.remainingUsd)} left).`}
        </p>
      )}

      <section className="stats" aria-label="Budget">
        <div className="card stat">
          <div className="stat-top">This month</div>
          <div className="stat-value">{formatUsd(c.total.totalUsd)}</div>
          <div className="stat-foot">
            of {formatUsd(c.budget.limitUsd)} ({b.monthly.mode}) · {c.total.calls} call(s)
          </div>
        </div>
        {thisMonth && (
          <>
            <div className="card stat">
              <div className="stat-top">Reserved</div>
              <div className="stat-value">{formatUsd(b.reservedUsd)}</div>
              <div className="stat-foot">queued or running work</div>
            </div>
            <div className="card stat">
              <div className="stat-top">Held</div>
              <div className="stat-value">{formatUsd(b.heldUsd)}</div>
              <div className="stat-foot">outcome unknown: resolve on the Operations page</div>
            </div>
            <div className="card stat">
              <div className="stat-top">Remaining</div>
              <div className="stat-value">{formatUsd(b.remainingUsd)}</div>
              <div className="stat-foot">
                {b.unknownCalls > 0
                  ? `${String(b.unknownCalls)} call(s) of unknown cost`
                  : 'this month'}
              </div>
            </div>
          </>
        )}
        <div className="card stat">
          <div className="stat-top">Retries</div>
          <div className="stat-value">{formatUsd(c.retryCost.totalUsd)}</div>
          <div className="stat-foot">calls that did not produce a result</div>
        </div>
        <div className="card stat">
          <div className="stat-top">Per approved video</div>
          <div className="stat-value">
            {c.costPerApprovedVideo ? formatUsd(c.costPerApprovedVideo.perVideoUsd) : '—'}
          </div>
          <div className="stat-foot">
            {c.costPerApprovedVideo
              ? `${String(c.costPerApprovedVideo.approvedVideos)} approved this month`
              : 'no render approved this month'}
          </div>
        </div>
      </section>

      <section className="card card-pad" aria-label="Six-month trend">
        <h2>Last six months</h2>
        <div className="chart cost-trend">
          {c.trend.map((t) => (
            <Link
              key={t.month}
              className="bar-group"
              href={`/projects/${projectId}/costs?month=${t.month}`}
            >
              <div
                className={t.month === c.month ? 'bar dark' : 'bar'}
                style={{
                  height: `${String(maxTrend > 0 ? Math.max(4, (Number(t.cost.totalUsd) / maxTrend) * 100) : 4)}%`,
                }}
                title={`${t.month}: ${formatUsd(t.cost.totalUsd)}`}
              />
              <span className="bar-label">
                {t.month} · {formatUsd(t.cost.totalUsd)}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <CostTable
        label="By content item"
        rows={c.byContentItem.map((r) => ({
          key: r.contentItemId,
          name: <Link href={`/content/${r.contentItemId}`}>{r.title}</Link>,
          cost: r.cost,
        }))}
      />
      <CostTable
        label="By stage"
        rows={c.byStage.map((r) => ({
          key: r.kind,
          name: STAGE_LABEL[r.kind] ?? r.kind,
          cost: r.cost,
        }))}
      />
      <CostTable
        label="By model"
        rows={c.byModel.map((r) => ({
          key: `${r.providerKey}/${r.modelKey}`,
          name: `${r.modelKey} (${r.providerKey})`,
          cost: r.cost,
        }))}
      />

      {project.data.role === 'owner' ? (
        <BudgetEditor budget={b} />
      ) : (
        <section className="card card-pad" aria-label="Budget limits">
          <h2>Budget limits</h2>
          <p className="small-text">
            Monthly {formatUsd(b.monthly.limitUsd)} ({b.monthly.mode}) · per content item{' '}
            {b.item.limitUsd === null ? 'none' : `${formatUsd(b.item.limitUsd)} (${b.item.mode})`} ·
            per request{' '}
            {b.request.limitUsd === null
              ? 'none'
              : `${formatUsd(b.request.limitUsd)} (${b.request.mode})`}
            . Only project owners change them.
          </p>
        </section>
      )}
    </div>
  );
}
