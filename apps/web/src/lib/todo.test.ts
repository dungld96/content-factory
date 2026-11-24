import { describe, expect, it } from 'vitest';

import type { ContentItemDto, OpsSummaryDto } from '@acf/contracts';

import { buildTodo } from './todo';

const item = (id: string, status: ContentItemDto['status'], updatedAt = '2026-11-20T10:00:00.000Z') =>
  ({ id, status, title: `T ${id}`, projectName: 'P', updatedAt }) as unknown as ContentItemDto & {
    projectName: string;
  };

const ops = (over: Partial<OpsSummaryDto>): OpsSummaryDto =>
  ({
    generatedAt: '2026-11-21T00:00:00.000Z',
    queues: [],
    jobs24h: [],
    failedJobs: [],
    circuits: [],
    budgets: [],
    heldReservations: [],
    ...over,
  }) as OpsSummaryDto;

describe('buildTodo (R2)', () => {
  it('lists open gates with the action of their stage', () => {
    const { items } = buildTodo(
      [item('a', 'script_review'), item('b', 'quality_review'), item('c', 'draft')],
      null,
    );
    expect(items.map((i) => [i.id, i.action, i.href])).toEqual([
      ['gate:a', 'todo.action.reviewScript', '/content/a#script'],
      ['gate:b', 'todo.action.reviewRender', '/content/b#render'],
    ]);
  });

  it('puts failures first, once per content item, and does not repeat failed content', () => {
    const failed = {
      kind: 'video_generation',
      errorCode: 'PROVIDER_TIMEOUT',
      errorMessage: null,
      attempt: 3,
      projectId: 'p',
      projectName: 'P',
      contentItemId: 'x',
      contentTitle: 'X',
      productionRunId: 'r',
    } as const;
    const { items } = buildTodo(
      [item('x', 'failed'), item('y', 'failed'), item('z', 'script_review')],
      ops({
        failedJobs: [
          { ...failed, jobId: 'j2', failedAt: '2026-11-21T00:00:00.000Z' },
          { ...failed, jobId: 'j1', failedAt: '2026-11-20T00:00:00.000Z' },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(['failed:j2', 'failed:y', 'gate:z']);
    expect(items[0]?.detail).toBe('PROVIDER_TIMEOUT');
  });

  it('adds held reservations and budgets near their limit', () => {
    const { items } = buildTodo(
      [],
      ops({
        budgets: [
          { projectId: 'p1', projectName: 'A', limitUsd: '50', usedUsd: '45', heldUsd: '0', warning: true },
          { projectId: 'p2', projectName: 'B', limitUsd: '50', usedUsd: '1', heldUsd: '0', warning: false },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(['budget:p1']);
  });

  it('separates running and finished work', () => {
    const r = buildTodo([item('a', 'rendering'), item('b', 'exported'), item('c', 'draft')], null);
    expect(r.running.map((c) => c.id)).toEqual(['a']);
    expect(r.ready.map((c) => c.id)).toEqual(['b']);
    expect(r.items).toEqual([]);
  });
});
