/** Content statuses (CONTENT_PIPELINE §1, decision U1); mirrors the database enum. */
export type ContentStatus =
  | 'draft'
  | 'researching'
  | 'planning'
  | 'scripting'
  | 'script_review'
  | 'storyboarding'
  | 'storyboard_review'
  | 'generating_assets'
  | 'asset_review'
  | 'rendering'
  | 'quality_review'
  | 'approved'
  | 'exported'
  | 'failed'
  | 'canceled'
  | 'needs_input';

export type PipelineEvent =
  | { readonly type: 'brief_invalid' }
  | { readonly type: 'script_job_queued' }
  | { readonly type: 'script_created' }
  | { readonly type: 'storyboard_job_queued' }
  | { readonly type: 'storyboard_created' }
  /** A job failed or was canceled: restore the status it started from. */
  | { readonly type: 'job_ended_without_result'; readonly previous: ContentStatus };

export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError';
  constructor(
    readonly from: ContentStatus,
    readonly event: PipelineEvent['type'],
  ) {
    super(`cannot apply ${event} to a content item in status ${from}`);
  }
}

const SCRIPT_START: ReadonlySet<ContentStatus> = new Set([
  'draft',
  'needs_input',
  'script_review',
  'storyboard_review',
]);
const STORYBOARD_START: ReadonlySet<ContentStatus> = new Set([
  'script_review',
  'storyboard_review',
]);
/** Statuses M3 owns; later stages (M4+) are not touched by M3 events. */
const M3_STATUSES: ReadonlySet<ContentStatus> = new Set([
  'draft',
  'needs_input',
  'scripting',
  'script_review',
  'storyboarding',
  'storyboard_review',
]);

/**
 * Content status transitions for M3 (design §9). Approvals do not change the status: gates are
 * recorded by the approval pointers; `generating_assets` is entered by M4.
 */
export function nextContentStatus(from: ContentStatus, event: PipelineEvent): ContentStatus {
  switch (event.type) {
    case 'brief_invalid':
      if (M3_STATUSES.has(from) && from !== 'scripting' && from !== 'storyboarding')
        return 'needs_input';
      break;
    case 'script_job_queued':
      if (SCRIPT_START.has(from)) return 'scripting';
      break;
    case 'script_created':
      if (from === 'scripting') return 'script_review';
      break;
    case 'storyboard_job_queued':
      if (STORYBOARD_START.has(from)) return 'storyboarding';
      break;
    case 'storyboard_created':
      if (from === 'storyboarding') return 'storyboard_review';
      break;
    case 'job_ended_without_result':
      if (from === 'scripting' || from === 'storyboarding') return event.previous;
      break;
  }
  throw new InvalidTransitionError(from, event.type);
}
