import type { ActiveJobDto, ActiveJobsDto, LiveJobEventDto } from '@acf/contracts';

/**
 * The client side of live job tracking (redesign R-D5): one store for the Jobs tray, the To-do
 * counters and the workspace. Pure reducer, unit tested; `store.ts` holds the instance.
 */
export type LiveTransport = 'connecting' | 'sse' | 'polling' | 'paused' | 'off';

export interface FinishedJob {
  readonly jobId: string;
  readonly contentItemId: string;
  readonly contentTitle: string;
  readonly kind: ActiveJobDto['kind'];
  readonly sceneNumber: number | null;
  readonly status: 'succeeded' | 'failed' | 'canceled';
  readonly at: string;
}

export interface LiveState {
  readonly cursor: string | null;
  readonly active: readonly ActiveJobDto[];
  /** Jobs that ended while this page was open, newest first (at most 10). */
  readonly finished: readonly FinishedJob[];
  readonly transport: LiveTransport;
  /** Event ids already applied (the server re-sends an overlap window). */
  readonly seen: ReadonlySet<string>;
}

export const INITIAL: LiveState = {
  cursor: null,
  active: [],
  finished: [],
  transport: 'off',
  seen: new Set(),
};

const ACTIVE = new Set(['queued', 'running']);
const MAX_SEEN = 2_000;

export function withSnapshot(state: LiveState, snapshot: ActiveJobsDto): LiveState {
  return { ...state, cursor: snapshot.cursor, active: snapshot.jobs };
}

/** Applies one job event; returns the same state when it was already applied. */
export function applyEvent(state: LiveState, e: LiveJobEventDto): LiveState {
  if (state.seen.has(e.id)) return state;
  const seen = new Set(state.seen);
  seen.add(e.id);
  if (seen.size > MAX_SEEN) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  const cursor = state.cursor === null || e.id > state.cursor ? e.id : state.cursor;
  const rest = state.active.filter((j) => j.jobId !== e.jobId);
  if (ACTIVE.has(e.to)) {
    const job: ActiveJobDto = {
      jobId: e.jobId,
      projectId: e.projectId,
      contentItemId: e.contentItemId,
      contentTitle: e.contentTitle,
      kind: e.kind,
      sceneNumber: e.sceneNumber,
      status: e.to === 'running' ? 'running' : 'queued',
      attempt: e.attempt,
      updatedAt: e.at,
    };
    return { ...state, seen, cursor, active: [...rest, job] };
  }
  const finished: FinishedJob = {
    jobId: e.jobId,
    contentItemId: e.contentItemId,
    contentTitle: e.contentTitle,
    kind: e.kind,
    sceneNumber: e.sceneNumber,
    status: e.to === 'succeeded' ? 'succeeded' : e.to === 'failed' ? 'failed' : 'canceled',
    at: e.at,
  };
  return {
    ...state,
    seen,
    cursor,
    active: rest,
    finished: [finished, ...state.finished.filter((f) => f.jobId !== e.jobId)].slice(0, 10),
  };
}

/** Polling cadence (package §5): 3 s with running jobs, 15 s idle, 60 s hidden; backoff on errors. */
export function pollDelay(input: {
  readonly activeJobs: number;
  readonly hidden: boolean;
  readonly failures: number;
  readonly random?: number;
}): number {
  const base = input.hidden ? 60_000 : input.activeJobs > 0 ? 3_000 : 15_000;
  if (input.failures === 0) return base;
  const backoff = Math.min(120_000, base * 2 ** Math.min(input.failures, 5));
  return Math.round(backoff * (0.75 + (input.random ?? Math.random()) * 0.5));
}
