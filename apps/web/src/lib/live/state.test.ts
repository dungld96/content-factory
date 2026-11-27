import { describe, expect, it } from 'vitest';

import type { LiveJobEventDto } from '@acf/contracts';

import { applyEvent, INITIAL, pollDelay, withSnapshot } from './state';

const ev = (id: string, jobId: string, to: LiveJobEventDto['to']): LiveJobEventDto => ({
  id,
  jobId,
  projectId: 'p',
  contentItemId: 'c',
  contentTitle: 'T',
  productionRunId: 'r',
  kind: 'video_generation',
  sceneNumber: 2,
  from: null,
  to,
  attempt: 1,
  at: '2026-11-23T10:00:00.000Z',
});

describe('live store (R-D5)', () => {
  it('tracks queued → running → succeeded and remembers finished jobs', () => {
    let s = withSnapshot(INITIAL, { cursor: '1700000000000-a', jobs: [] });
    s = applyEvent(s, ev('1700000000001-a', 'j1', 'queued'));
    expect(s.active.map((j) => [j.jobId, j.status])).toEqual([['j1', 'queued']]);
    s = applyEvent(s, ev('1700000000002-a', 'j1', 'running'));
    expect(s.active.map((j) => j.status)).toEqual(['running']);
    s = applyEvent(s, ev('1700000000003-a', 'j1', 'succeeded'));
    expect(s.active).toEqual([]);
    expect(s.finished.map((f) => [f.jobId, f.status])).toEqual([['j1', 'succeeded']]);
    expect(s.cursor).toBe('1700000000003-a');
  });

  it('ignores an event it already applied (overlap re-sends)', () => {
    const once = applyEvent(INITIAL, ev('1700000000001-a', 'j1', 'queued'));
    expect(applyEvent(once, ev('1700000000001-a', 'j1', 'queued'))).toBe(once);
  });

  it('never moves the cursor backwards', () => {
    let s = applyEvent(INITIAL, ev('1700000000009-a', 'j1', 'queued'));
    s = applyEvent(s, ev('1700000000005-b', 'j2', 'queued'));
    expect(s.cursor).toBe('1700000000009-a');
  });
});

describe('pollDelay', () => {
  it('polls faster with running jobs and slower when hidden', () => {
    expect(pollDelay({ activeJobs: 2, hidden: false, failures: 0 })).toBe(3_000);
    expect(pollDelay({ activeJobs: 0, hidden: false, failures: 0 })).toBe(15_000);
    expect(pollDelay({ activeJobs: 2, hidden: true, failures: 0 })).toBe(60_000);
  });

  it('backs off with jitter on errors, capped', () => {
    expect(pollDelay({ activeJobs: 1, hidden: false, failures: 2, random: 0.5 })).toBe(12_000);
    expect(pollDelay({ activeJobs: 0, hidden: true, failures: 9, random: 1 })).toBe(150_000);
  });
});
