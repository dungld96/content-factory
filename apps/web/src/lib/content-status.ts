import type { ContentStatus } from '@acf/contracts';

import type { MessageKey } from './i18n';

/** Visual tone of a status pill (maps to `.status.<tone>` in globals.css). */
export type Tone = 'green' | 'amber' | 'purple' | 'gray' | 'red';

/** Production stage a content status belongs to (board columns, pipeline health). */
export type Stage = 'draft' | 'script' | 'storyboard' | 'images' | 'render' | 'done' | 'attention';

interface StatusInfo {
  /** Dictionary key of the status name (`status.<status>`). */
  readonly label: MessageKey;
  readonly tone: Tone;
  readonly stage: Stage;
}

const STATUS: Readonly<Record<ContentStatus, StatusInfo>> = {
  draft: { label: 'status.draft', tone: 'gray', stage: 'draft' },
  researching: { label: 'status.researching', tone: 'purple', stage: 'draft' },
  planning: { label: 'status.planning', tone: 'purple', stage: 'draft' },
  scripting: { label: 'status.scripting', tone: 'purple', stage: 'script' },
  script_review: { label: 'status.script_review', tone: 'amber', stage: 'script' },
  storyboarding: { label: 'status.storyboarding', tone: 'purple', stage: 'storyboard' },
  storyboard_review: { label: 'status.storyboard_review', tone: 'amber', stage: 'storyboard' },
  generating_assets: { label: 'status.generating_assets', tone: 'purple', stage: 'images' },
  asset_review: { label: 'status.asset_review', tone: 'amber', stage: 'images' },
  rendering: { label: 'status.rendering', tone: 'purple', stage: 'render' },
  quality_review: { label: 'status.quality_review', tone: 'amber', stage: 'render' },
  approved: { label: 'status.approved', tone: 'green', stage: 'done' },
  exported: { label: 'status.exported', tone: 'green', stage: 'done' },
  failed: { label: 'status.failed', tone: 'red', stage: 'attention' },
  canceled: { label: 'status.canceled', tone: 'gray', stage: 'attention' },
  needs_input: { label: 'status.needs_input', tone: 'amber', stage: 'attention' },
};

export const statusInfo = (status: ContentStatus): StatusInfo => STATUS[status];

/** Statuses where work is under way (not draft, finished or stopped). */
const IN_PRODUCTION: ReadonlySet<ContentStatus> = new Set([
  'researching',
  'planning',
  'scripting',
  'script_review',
  'storyboarding',
  'storyboard_review',
  'generating_assets',
  'asset_review',
  'rendering',
  'quality_review',
  'needs_input',
]);

/** Statuses waiting for a human decision (a review gate or missing input). */
const NEEDS_REVIEW: ReadonlySet<ContentStatus> = new Set([
  'script_review',
  'storyboard_review',
  'asset_review',
  'quality_review',
  'needs_input',
]);

/** Statuses where a generation job is running (pages refresh while it runs). */
const GENERATING: ReadonlySet<ContentStatus> = new Set([
  'scripting',
  'storyboarding',
  'generating_assets',
  'rendering',
]);

export const isInProduction = (s: ContentStatus) => IN_PRODUCTION.has(s);
export const needsReview = (s: ContentStatus) => NEEDS_REVIEW.has(s);
export const isGenerating = (s: ContentStatus) => GENERATING.has(s);
export const isFinished = (s: ContentStatus) => s === 'approved' || s === 'exported';

/** Status filter groups offered by the content library. */
export const STATUS_FILTERS = [
  { value: 'in_production', label: 'filter.in_production' },
  { value: 'needs_review', label: 'filter.needs_review' },
  { value: 'draft', label: 'filter.draft' },
  { value: 'approved', label: 'filter.approved' },
  { value: 'attention', label: 'filter.attention' },
] as const satisfies readonly { value: string; label: MessageKey }[];
export type StatusFilter = (typeof STATUS_FILTERS)[number]['value'];

export function isStatusFilter(value: string | undefined): value is StatusFilter {
  return STATUS_FILTERS.some((f) => f.value === value);
}

export function matchesStatusFilter(status: ContentStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case 'in_production':
      return isInProduction(status);
    case 'needs_review':
      return needsReview(status);
    case 'draft':
      return status === 'draft';
    case 'approved':
      return isFinished(status);
    case 'attention':
      return status === 'failed' || status === 'canceled';
  }
}

export interface StageCount {
  readonly stage: Stage;
  readonly total: number;
  /** Items of this stage that wait for a review. */
  readonly waiting: number;
}

/** Counts per stage, in board order. */
export function countByStage(statuses: readonly ContentStatus[]): StageCount[] {
  const order: Stage[] = ['draft', 'script', 'storyboard', 'images', 'render', 'done', 'attention'];
  return order.map((stage) => {
    const inStage = statuses.filter((s) => STATUS[s].stage === stage);
    return { stage, total: inStage.length, waiting: inStage.filter(needsReview).length };
  });
}

/** Dictionary keys of the stage names. */
export const STAGE_LABEL: Readonly<Record<Stage, MessageKey>> = {
  draft: 'stage.draft',
  script: 'stage.script',
  storyboard: 'stage.storyboard',
  images: 'stage.images',
  render: 'stage.render',
  done: 'stage.done',
  attention: 'stage.attention',
};

export interface WeekBucket {
  /** Monday 00:00 UTC of the week, ISO date (YYYY-MM-DD). */
  readonly weekStart: string;
  readonly created: number;
  /** Of the items created that week, those now approved or exported. */
  readonly finished: number;
}

const DAY_MS = 86_400_000;

/** Monday 00:00 UTC of the week containing `date`. */
function weekStartUtc(date: Date): number {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS;
}

/** Content created per UTC week over the last `weeks` weeks (oldest first), current week last. */
export function weeklyCreation(
  items: readonly { readonly createdAt: string; readonly status: ContentStatus }[],
  now: Date,
  weeks = 8,
): WeekBucket[] {
  const current = weekStartUtc(now);
  const starts = Array.from({ length: weeks }, (_, i) => current - (weeks - 1 - i) * 7 * DAY_MS);
  return starts.map((start) => {
    const inWeek = items.filter((item) => weekStartUtc(new Date(item.createdAt)) === start);
    return {
      weekStart: new Date(start).toISOString().slice(0, 10),
      created: inWeek.length,
      finished: inWeek.filter((item) => isFinished(item.status)).length,
    };
  });
}
