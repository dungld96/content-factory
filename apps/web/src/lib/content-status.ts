import type { ContentStatus } from '@acf/contracts';

/** Visual tone of a status pill (maps to `.status.<tone>` in globals.css). */
export type Tone = 'green' | 'amber' | 'purple' | 'gray' | 'red';

/** Production stage a content status belongs to (board columns, pipeline health). */
export type Stage = 'draft' | 'script' | 'storyboard' | 'images' | 'render' | 'done' | 'attention';

interface StatusInfo {
  readonly label: string;
  readonly tone: Tone;
  readonly stage: Stage;
}

const STATUS: Readonly<Record<ContentStatus, StatusInfo>> = {
  draft: { label: 'Draft', tone: 'gray', stage: 'draft' },
  researching: { label: 'Researching', tone: 'purple', stage: 'draft' },
  planning: { label: 'Planning', tone: 'purple', stage: 'draft' },
  scripting: { label: 'Generating script', tone: 'purple', stage: 'script' },
  script_review: { label: 'Script review', tone: 'amber', stage: 'script' },
  storyboarding: { label: 'Generating storyboard', tone: 'purple', stage: 'storyboard' },
  storyboard_review: { label: 'Storyboard review', tone: 'amber', stage: 'storyboard' },
  generating_assets: { label: 'Generating images', tone: 'purple', stage: 'images' },
  asset_review: { label: 'Asset review', tone: 'amber', stage: 'images' },
  rendering: { label: 'Rendering', tone: 'purple', stage: 'render' },
  quality_review: { label: 'Quality review', tone: 'amber', stage: 'render' },
  approved: { label: 'Approved', tone: 'green', stage: 'done' },
  exported: { label: 'Exported', tone: 'green', stage: 'done' },
  failed: { label: 'Failed', tone: 'red', stage: 'attention' },
  canceled: { label: 'Canceled', tone: 'gray', stage: 'attention' },
  needs_input: { label: 'Needs input', tone: 'amber', stage: 'attention' },
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
]);

export const isInProduction = (s: ContentStatus) => IN_PRODUCTION.has(s);
export const needsReview = (s: ContentStatus) => NEEDS_REVIEW.has(s);
export const isGenerating = (s: ContentStatus) => GENERATING.has(s);
export const isFinished = (s: ContentStatus) => s === 'approved' || s === 'exported';

/** Status filter groups offered by the content library. */
export const STATUS_FILTERS = [
  { value: 'in_production', label: 'In production' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved or exported' },
  { value: 'attention', label: 'Failed or canceled' },
] as const;
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

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  draft: 'Draft',
  script: 'Script',
  storyboard: 'Storyboard',
  images: 'Scene images',
  render: 'Render & quality',
  done: 'Approved',
  attention: 'Needs attention',
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
