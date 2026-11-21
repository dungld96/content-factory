import type { ContentItemDto } from '@acf/contracts';

import { isStatusFilter, matchesStatusFilter, STATUS_FILTERS } from './content-status';
import { PLATFORM_OPTIONS } from './format';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** First value of a query parameter, or undefined when absent or empty. */
export function param(params: SearchParams, name: string): string | undefined {
  const value = params[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() ? first.trim() : undefined;
}

export interface ContentFilter {
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly platform?: string | undefined;
  readonly project?: string | undefined;
}

export function contentFilterFrom(params: SearchParams): ContentFilter {
  return {
    q: param(params, 'q'),
    status: param(params, 'status'),
    platform: param(params, 'platform'),
    project: param(params, 'project'),
  };
}

/** Applies the content library filters (unknown values are ignored, not "match nothing"). */
export function filterContent<T extends ContentItemDto>(
  items: readonly T[],
  f: ContentFilter,
): T[] {
  const q = f.q?.toLocaleLowerCase();
  const status = isStatusFilter(f.status) ? f.status : undefined;
  return items.filter(
    (item) =>
      (!q ||
        item.title.toLocaleLowerCase().includes(q) ||
        item.brief.topic.toLocaleLowerCase().includes(q)) &&
      (!status || matchesStatusFilter(item.status, status)) &&
      (!f.platform ||
        (f.platform === 'none'
          ? item.targetPlatform === null
          : item.targetPlatform === f.platform)) &&
      (!f.project || item.projectId === f.project),
  );
}

export const STATUS_SELECT = {
  name: 'status',
  label: 'Status',
  allLabel: 'All statuses',
  options: STATUS_FILTERS,
} as const;

export const PLATFORM_SELECT = {
  name: 'platform',
  label: 'Platform',
  allLabel: 'All platforms',
  options: [...PLATFORM_OPTIONS, { value: 'none', label: 'No platform' }],
} as const;
