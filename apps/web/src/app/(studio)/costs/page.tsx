import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Fragment } from 'react';

import type { BudgetDto, ProjectCostsDto } from '@acf/contracts';

import { PageCrumbs } from '@/components/shell/page-crumbs';
import { apiGet } from '@/lib/api-server';
import { jobKindLabel } from '@/lib/format';
import { getLocale, getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';
import { addUsd, formatUsd } from '@/lib/money';
import { projectSwatch } from '@/lib/project-swatch';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('costs.pageTitle') };
}

/** Percentage of `part` in `whole` (decimal strings), 0–100, for meters only. */
function percent(part: string, whole: string): number {
  const w = Number(whole);
  if (!(w > 0)) return 0;
  return Math.min(100, Math.round((Number(part) / w) * 100));
}

/**
 * Workspace costs (redesign R-D1): this month's spending of every project the user belongs to,
 * each against its monthly limit. Built from the existing project budget and cost endpoints.
 */
export default async function CostsPage() {
  const [me, t, locale] = await Promise.all([getMe(), getT(), getLocale()]);
  if (me.kind === 'unauthenticated') redirect('/login');
  if (me.kind === 'error') {
    return (
      <section className="card notice error" role="alert">
        {t('costs.loadError')}
      </section>
    );
  }
  const rows = await Promise.all(
    me.data.memberships.map(async (m) => {
      const [budget, costs] = await Promise.all([
        apiGet<BudgetDto>(`/projects/${m.projectId}/budget`),
        apiGet<ProjectCostsDto>(`/projects/${m.projectId}/costs`),
      ]);
      return {
        membership: m,
        budget: budget.kind === 'ok' ? budget.data : null,
        costs: costs.kind === 'ok' ? costs.data : null,
      };
    }),
  );
  const loaded = rows.filter((r) => r.budget && r.costs);
  const month = loaded[0]?.costs?.month ?? new Date().toISOString().slice(0, 7);
  const total = addUsd(...loaded.map((r) => r.costs?.total.totalUsd ?? '0'));
  const limits = addUsd(...loaded.map((r) => r.budget?.monthly.limitUsd ?? '0'));
  const reserved = addUsd(...loaded.map((r) => r.budget?.reservedUsd ?? '0'));
  const held = addUsd(...loaded.map((r) => r.budget?.heldUsd ?? '0'));
  const unknownCalls = loaded.reduce((n, r) => n + (r.costs?.total.unknownCalls ?? 0), 0);
  // Per approved video: all-time cost of approved items, weighted by their count.
  const approved = loaded.flatMap((r) =>
    r.costs?.costPerApprovedVideo ? [r.costs.costPerApprovedVideo] : [],
  );
  const approvedVideos = approved.reduce((n, a) => n + a.approvedVideos, 0);
  const perVideo =
    approvedVideos > 0
      ? (
          approved.reduce((sum, a) => sum + Number(a.perVideoUsd) * a.approvedVideos, 0) /
          approvedVideos
        ).toFixed(2)
      : null;
  // Six months, oldest first, summed over projects.
  const months = loaded[0]?.costs?.trend.map((p) => p.month) ?? [];
  const trend = months.map((m) => ({
    month: m,
    total: addUsd(
      ...loaded.map((r) => r.costs?.trend.find((p) => p.month === m)?.cost.totalUsd ?? '0'),
    ),
  }));
  const peak = Math.max(0.01, ...trend.map((p) => Number(p.total)));
  const byStage = new Map<string, string>();
  for (const r of loaded) {
    for (const st of r.costs?.byStage ?? []) {
      byStage.set(st.kind, addUsd(byStage.get(st.kind) ?? '0', st.cost.totalUsd));
    }
  }
  const items = loaded
    .flatMap((r) =>
      (r.costs?.byContentItem ?? []).map((i) => ({ ...i, projectName: r.membership.projectName })),
    )
    .sort((a, b) => Number(b.cost.totalUsd) - Number(a.cost.totalUsd))
    .slice(0, 10);
  const monthLabel = (m: string, style: 'short' | 'long') =>
    new Intl.DateTimeFormat(locale, {
      month: style,
      year: style === 'long' ? 'numeric' : undefined,
      timeZone: 'UTC',
    }).format(new Date(`${m}-01T00:00:00Z`));

  return (
    <>
      <PageCrumbs items={[{ label: t('nav.costs') }]} />
      <div className="page-head">
        <div>
          <h1>{t('costs.titleFull')}</h1>
          <p>{t('costs.leadShort', { month: monthLabel(month, 'long') })}</p>
        </div>
      </div>

      <section className="kpis" aria-label={t('costs.thisMonth')}>
        <div className="card kpi">
          <span className="eyebrow">{t('costs.spent')}</span>
          <span className="v num">{formatUsd(total)}</span>
          <span className="t-13 muted">{t('costs.ofLimits', { limit: formatUsd(limits) })}</span>
        </div>
        <div className="card kpi">
          <span className="eyebrow">{t('costs.reserved')}</span>
          <span className="v num">{formatUsd(reserved)}</span>
          <span className="t-13 muted">
            {t('costs.reservedFoot')}
            {held !== '0' ? ` · ${t('costs.heldPart', { amount: formatUsd(held) })}` : ''}
          </span>
        </div>
        <div className="card kpi">
          <span className="eyebrow">{t('costs.perVideo')}</span>
          <span className="v num">{perVideo ? formatUsd(perVideo) : '—'}</span>
          <span className="t-13 muted">{t('costs.perVideoFoot', { count: approvedVideos })}</span>
        </div>
        <div className={unknownCalls > 0 ? 'card kpi unknown' : 'card kpi'}>
          <span className="eyebrow">{t('costs.unknown')}</span>
          <span className="v num">{t('costs.unknownCalls', { count: unknownCalls })}</span>
          <span className="t-13 muted">
            {t('costs.unknownFootShort')} ·{' '}
            <Link href="/settings/models">{t('costs.addPrice')}</Link>
          </span>
        </div>
      </section>

      <div className="row wrap costs-mid">
        <section className="card costs-chart" aria-labelledby="costs-trend">
          <div className="card-head">
            <h3 id="costs-trend">{t('costs.trend')}</h3>
          </div>
          <div className="card-body col">
            <div
              className="plot"
              role="img"
              aria-label={t('costs.trendAria', {
                months: trend
                  .map((p) => `${monthLabel(p.month, 'short')} ${formatUsd(p.total)}`)
                  .join(', '),
              })}
            >
              {trend.map((p) => (
                <div
                  key={p.month}
                  className="bar-col"
                  title={`${monthLabel(p.month, 'long')}: ${formatUsd(p.total)}`}
                >
                  <span className="bar-v t-12 num">{formatUsd(p.total)}</span>
                  <span
                    className={p.month === month ? 'bar now' : 'bar'}
                    style={{
                      height: `${String(Math.max(2, Math.round((Number(p.total) / peak) * 160)))}px`,
                    }}
                  />
                  <span className="t-12 muted">{monthLabel(p.month, 'short')}</span>
                </div>
              ))}
            </div>
            <details className="t-13">
              <summary>{t('costs.byStageNow')}</summary>
              <dl className="kv">
                {[...byStage.entries()].map(([kind, amount]) => (
                  <Fragment key={kind}>
                    <dt>{jobKindLabel(t, kind)}</dt>
                    <dd>{formatUsd(amount)}</dd>
                  </Fragment>
                ))}
              </dl>
            </details>
            <p className="t-12 muted">{t('costs.chartNote')}</p>
          </div>
        </section>

        <section className="card costs-budgets" aria-label={t('costs.budgets')}>
          <div className="card-head">
            <h3>{t('costs.budgets')}</h3>
            <span className="spacer" />
            <Link className="btn sm" href="/settings/budgets">
              {t('costs.editLimits')}
            </Link>
          </div>
          <div className="card-body col">
            {rows.length === 0 ? (
              <p className="muted t-13">{t('costs.noProjects')}</p>
            ) : (
              rows.map(({ membership: m, budget: b }) => (
                <div key={m.projectId} className="col budget-row">
                  <div className="row t-13">
                    <span
                      className="sw"
                      style={{ background: projectSwatch(m.projectId) }}
                      aria-hidden="true"
                    />
                    <Link href={`/projects/${m.projectId}/costs`}>
                      <b>{m.projectName}</b>
                    </Link>
                    <span className="spacer" />
                    {b ? (
                      <span className="num">
                        {formatUsd(b.spentUsd)}{' '}
                        <span className="muted">/ {formatUsd(b.monthly.limitUsd)}</span>
                      </span>
                    ) : (
                      <span className="muted">{t('costs.unavailable')}</span>
                    )}
                  </div>
                  {b && (
                    <>
                      <div
                        className="meter"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent(b.spentUsd, b.monthly.limitUsd)}
                        aria-label={t('costs.used', {
                          percent: percent(b.spentUsd, b.monthly.limitUsd),
                        })}
                      >
                        <i
                          className="spent"
                          style={{ width: `${String(percent(b.spentUsd, b.monthly.limitUsd))}%` }}
                        />
                        <i
                          className="reserved"
                          style={{
                            width: `${String(percent(addUsd(b.reservedUsd, b.heldUsd), b.monthly.limitUsd))}%`,
                          }}
                        />
                      </div>
                      <span className={b.warning ? 't-12 warn-text' : 't-12 muted'}>
                        {b.warning
                          ? t('costs.warnLine', { left: formatUsd(b.remainingUsd) })
                          : t('costs.okLine', {
                              reserved: formatUsd(b.reservedUsd),
                              left: formatUsd(b.remainingUsd),
                            })}
                      </span>
                    </>
                  )}
                </div>
              ))
            )}
            <div className="row t-12 muted legend">
              <span className="row">
                <span className="key spent" />
                {t('costs.spent')}
              </span>
              <span className="row">
                <span className="key reserved" />
                {t('costs.reserved')}
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="costs-items">
        <div className="card-head">
          <h3 id="costs-items">{t('costs.topItems')}</h3>
        </div>
        {items.length === 0 ? (
          <div className="card-body">
            <p className="muted t-13">{t('costs.noItems')}</p>
          </div>
        ) : (
          <div className="table-box">
            <table className="table" aria-label={t('costs.topItems')}>
              <thead>
                <tr>
                  <th>{t('costs.colContent')}</th>
                  <th className="r">{t('costs.colCalls')}</th>
                  <th className="r">{t('costs.colReported')}</th>
                  <th className="r">{t('costs.colEstimated')}</th>
                  <th className="r">{t('costs.colUnknown')}</th>
                  <th className="r">{t('costs.colTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.contentItemId}>
                    <td>
                      <Link href={`/content/${i.contentItemId}`}>
                        <b>{i.title}</b>
                      </Link>
                      <div className="t-12 muted">{i.projectName}</div>
                    </td>
                    <td className="r num">{i.cost.calls}</td>
                    <td className="r num">{formatUsd(i.cost.reportedUsd)}</td>
                    <td className="r num">{formatUsd(i.cost.estimatedUsd)}</td>
                    <td className="r num">{i.cost.unknownCalls}</td>
                    <td className="r num">
                      <b>{formatUsd(i.cost.totalUsd)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
