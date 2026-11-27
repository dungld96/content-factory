import Link from 'next/link';

import { isFinished } from '@/lib/content-status';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatUsdSummary } from '@/lib/money';
import { loadOpsSummary } from '@/lib/ops-summary';
import { loadMonthSpend } from '@/lib/spend';
import { buildTodo } from '@/lib/todo';
import { loadWorkspace } from '@/lib/workspace';

import { SidebarNav } from './sidebar-nav';

/**
 * The menu with its badges (design canvas): open To-do items, productions not yet finished and
 * failed jobs. Streamed behind a Suspense boundary so the shell never waits for these reads;
 * the workspace and operations reads are shared with the page (per-request cache).
 */
export async function SidebarNavWithCounts() {
  const [workspace, ops] = await Promise.all([loadWorkspace(), loadOpsSummary()]);
  if (workspace.kind !== 'ok') return <SidebarNav />;
  const summary = ops.kind === 'ok' ? ops.data : null;
  const todo = buildTodo(workspace.data.content, summary);
  return (
    <SidebarNav
      counts={{
        '/': todo.items.length,
        '/productions': workspace.data.content.filter((c) => !isFinished(c.status)).length,
        '/operations': summary?.failedJobs.length ?? 0,
      }}
    />
  );
}

/** Share of `part` in `whole` (decimal strings), 0–100, for the meter only. */
function percent(part: string, whole: string): number {
  const w = Number(whole);
  if (!(w > 0)) return 0;
  return Math.min(100, Math.round((Number(part) / w) * 100));
}

/**
 * This month's spending across the user's projects against the sum of their monthly limits
 * (design canvas, sidebar bottom). Reported or estimated spend; reservations shown apart.
 */
export async function SidebarSpend() {
  const [spend, t, locale] = await Promise.all([loadMonthSpend(), getT(), getLocale()]);
  if (!spend) return null;
  const month = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(spend.periodStart),
  );
  const used = percent(spend.spentUsd, spend.limitUsd);
  const held = Math.min(100 - used, percent(spend.reservedUsd, spend.limitUsd));
  return (
    <Link className="spend-mini" href="/costs" aria-label={t('nav.spendLabel')}>
      <span className="row">
        {t('nav.spend', { month })}
        <span className="spacer" />
        <b className="num">{formatUsdSummary(spend.spentUsd)}</b>
      </span>
      <span className="meter" aria-hidden="true">
        <i className="spent" style={{ width: `${String(used)}%` }} />
        <i className="reserved" style={{ width: `${String(held)}%` }} />
      </span>
      <span>
        {t('nav.spendOf', {
          limit: formatUsdSummary(spend.limitUsd),
          reserved: formatUsdSummary(spend.reservedUsd),
        })}
      </span>
    </Link>
  );
}
