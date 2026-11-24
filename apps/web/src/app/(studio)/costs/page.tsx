import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { BudgetDto, ProjectCostsDto } from '@acf/contracts';

import { CostFigure } from '@/components/cost-figure';
import { Pill } from '@/components/status-pill';
import { apiGet } from '@/lib/api-server';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';
import { addUsd, formatUsd } from '@/lib/money';

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
  const [me, t] = await Promise.all([getMe(), getT()]);
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
  const calls = loaded.reduce((n, r) => n + (r.costs?.total.calls ?? 0), 0);
  const limits = addUsd(...loaded.map((r) => r.budget?.monthly.limitUsd ?? '0'));
  const reserved = addUsd(...loaded.map((r) => r.budget?.reservedUsd ?? '0'));
  const held = addUsd(...loaded.map((r) => r.budget?.heldUsd ?? '0'));
  const unknownCalls = loaded.reduce((n, r) => n + (r.budget?.unknownCalls ?? 0), 0);

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('costs.eyebrow')}</div>
          <h1>{t('costs.title')}</h1>
          <p>{t('costs.lead', { month })}</p>
        </div>
      </div>

      <section className="stats" aria-label={t('costs.title')}>
        <div className="card stat">
          <div className="stat-top">{t('costs.total')}</div>
          <div className="stat-value">{formatUsd(total)}</div>
          <div className="stat-foot">
            {t('costs.totalFoot', { calls, count: loaded.length })}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('costs.limits')}</div>
          <div className="stat-value">{formatUsd(limits)}</div>
          <div className="stat-foot">{t('costs.limitsFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('costs.reserved')}</div>
          <div className="stat-value">{formatUsd(reserved)}</div>
          <div className="stat-foot">{t('costs.reservedFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('costs.held')}</div>
          <div className="stat-value">{formatUsd(held)}</div>
          <div className="stat-foot">{t('costs.heldFoot')}</div>
        </div>
        <div className="card stat">
          <div className="stat-top">{t('costs.unknown')}</div>
          <div className="stat-value">{unknownCalls > 0 ? `${String(unknownCalls)} ?` : '0'}</div>
          <div className="stat-foot">{t('costs.unknownFoot')}</div>
        </div>
      </section>

      <section className="card card-pad">
        <h2>{t('costs.byProject')}</h2>
        {rows.length === 0 ? (
          <p className="muted small-text">{t('costs.noProjects')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label={t('costs.byProject')}>
              <thead>
                <tr>
                  <th scope="col">{t('costs.colProject')}</th>
                  <th scope="col">{t('costs.colSpent')}</th>
                  <th scope="col">{t('costs.colLimit')}</th>
                  <th scope="col">{t('costs.colRemaining')}</th>
                  <th scope="col">{t('costs.colUse')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('costs.details')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ membership: m, budget: b, costs: c }) => {
                  const used = b ? percent(addUsd(b.spentUsd, b.reservedUsd, b.heldUsd), b.monthly.limitUsd) : 0;
                  return (
                    <tr key={m.projectId}>
                      <td className="table-title">
                        <Link href={`/projects/${m.projectId}`}>{m.projectName}</Link>
                      </td>
                      <td>{c ? <CostFigure cost={c.total} t={t} /> : t('costs.unavailable')}</td>
                      <td>
                        {b
                          ? `${formatUsd(b.monthly.limitUsd)} (${t(b.monthly.mode === 'hard' ? 'mode.hard' : 'mode.soft')})`
                          : '—'}
                      </td>
                      <td>{b ? formatUsd(b.remainingUsd) : '—'}</td>
                      <td>
                        {b && (
                          <span className="meter-cell">
                            <span
                              className={used >= 80 ? 'meter warn' : 'meter'}
                              role="meter"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={used}
                              aria-label={t('costs.used', { percent: used })}
                            >
                              <span style={{ width: `${String(used)}%` }} />
                            </span>
                            <span className="small-text">{used} %</span>
                            {b.warning && <Pill tone="amber">{t('costs.warning80')}</Pill>}
                          </span>
                        )}
                      </td>
                      <td>
                        <Link className="link" href={`/projects/${m.projectId}/costs`}>
                          {t('costs.details')}
                        </Link>
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
