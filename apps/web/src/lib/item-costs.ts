import 'server-only';

import { cache } from 'react';

import type { ProjectCostsDto } from '@acf/contracts';

import { apiGet } from './api-server';
import { getMe } from './me';

export interface ItemCost {
  /** Reported, else estimated, cost this UTC month. */
  readonly totalUsd: string;
  /** Calls whose cost is unknown (never priced). */
  readonly unknownCalls: number;
}

/**
 * This month's cost per content item across the user's projects (from the project cost
 * dashboards), read once per request. Items without calls this month are absent.
 */
export const loadItemCosts = cache(async (): Promise<ReadonlyMap<string, ItemCost>> => {
  const me = await getMe();
  const costs = new Map<string, ItemCost>();
  if (me.kind !== 'ok') return costs;
  const lists = await Promise.all(
    me.data.memberships.map((m) => apiGet<ProjectCostsDto>(`/projects/${m.projectId}/costs`)),
  );
  for (const list of lists) {
    if (list.kind !== 'ok') continue;
    for (const row of list.data.byContentItem) {
      costs.set(row.contentItemId, {
        totalUsd: row.cost.totalUsd,
        unknownCalls: row.cost.unknownCalls,
      });
    }
  }
  return costs;
});
