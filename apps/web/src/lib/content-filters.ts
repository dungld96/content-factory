import type { ContentItemDto } from '@acf/contracts';

import { isStatusFilter, matchesStatusFilter, STATUS_FILTERS } from './content-status';
import { platformOptions } from './format';
import type { Translate } from './i18n';

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

export function statusSelect(t: Translate) {
  return {
    name: 'status',
    label: t('filter.status'),
    allLabel: t('filter.allStatuses'),
    options: STATUS_FILTERS.map((f) => ({ value: f.value, label: t(f.label) })),
  } as const;
}

export function platformSelect(t: Translate) {
  return {
    name: 'platform',
    label: t('filter.platform'),
    allLabel: t('filter.allPlatforms'),
    options: [...platformOptions(t), { value: 'none', label: t('platform.none') }],
  } as const;
}
