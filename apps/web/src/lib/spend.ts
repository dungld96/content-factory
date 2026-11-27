import 'server-only';

import { cache } from 'react';

import type { BudgetDto } from '@acf/contracts';

import { apiGet } from './api-server';
import { getMe } from './me';
import { addUsd } from './money';

export interface MonthSpend {
  /** Ledger cost this month across the user's projects (reported, else estimated). */
  readonly spentUsd: string;
  readonly reservedUsd: string;
  /** Sum of the projects' monthly limits. */
  readonly limitUsd: string;
  readonly periodStart: string;
}

/**
 * This month's spending of every project the user belongs to, summed from the project budgets.
 * Read once per request (sidebar meter and To-do summary). `null` when no budget could be read.
 */
export const loadMonthSpend = cache(async (): Promise<MonthSpend | null> => {
  const me = await getMe();
  if (me.kind !== 'ok' || me.data.memberships.length === 0) return null;
  const budgets = await Promise.all(
    me.data.memberships.map((m) => apiGet<BudgetDto>(`/projects/${m.projectId}/budget`)),
  );
  const loaded = budgets.flatMap((b) => (b.kind === 'ok' ? [b.data] : []));
  const first = loaded[0];
  if (!first) return null;
  return {
    spentUsd: addUsd(...loaded.map((b) => b.spentUsd)),
    reservedUsd: addUsd(...loaded.map((b) => b.reservedUsd)),
    limitUsd: addUsd(...loaded.map((b) => b.monthly.limitUsd)),
    periodStart: first.periodStart,
  };
});
