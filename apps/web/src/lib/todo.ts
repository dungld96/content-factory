import type { ContentItemDto, ContentStatus, OpsSummaryDto } from '@acf/contracts';

import { isFinished, isGenerating } from './content-status';
import type { MessageKey } from './i18n';

/**
 * The To-do queue (redesign R2, R-D2): the decisions waiting for the operator, built from data
 * the studio already loads (content lists and the operations summary). Pure, unit tested.
 */
export type TodoKind = 'gate' | 'input' | 'failed' | 'held' | 'budget';

export interface TodoItem {
  readonly id: string;
  readonly kind: TodoKind;
  /** Lower comes first. */
  readonly priority: number;
  readonly title: string;
  readonly projectName: string;
  /** What has to be decided, as a dictionary key. */
  readonly reason: MessageKey;
  /** The primary action's label key and where it leads. */
  readonly action: MessageKey;
  readonly href: string;
  /** Extra values for the reason text (error code, amount). */
  readonly detail?: string | undefined;
  /** Approval gate number (1–4) of a gate item. */
  readonly gate?: 1 | 2 | 3 | 4 | undefined;
  readonly at: string;
}

type Content = ContentItemDto & { readonly projectName: string };

const GATES: Partial<
  Record<
    ContentStatus,
    { reason: MessageKey; action: MessageKey; hash: string; priority: number; gate: 1 | 2 | 3 | 4 }
  >
> = {
  script_review: {
    gate: 1,
    reason: 'todo.reason.script',
    action: 'todo.action.reviewScript',
    hash: '#script',
    priority: 20,
  },
  storyboard_review: {
    gate: 2,
    reason: 'todo.reason.storyboard',
    action: 'todo.action.reviewStoryboard',
    hash: '#storyboard',
    priority: 21,
  },
  asset_review: {
    gate: 3,
    reason: 'todo.reason.scenes',
    action: 'todo.action.reviewScenes',
    hash: '#scenes',
    priority: 22,
  },
  quality_review: {
    gate: 4,
    reason: 'todo.reason.render',
    action: 'todo.action.reviewRender',
    hash: '#render',
    priority: 23,
  },
};

export interface TodoResult {
  readonly items: TodoItem[];
  readonly running: Content[];
  readonly ready: Content[];
}

export function buildTodo(content: readonly Content[], ops: OpsSummaryDto | null): TodoResult {
  const items: TodoItem[] = [];
  const failedContent = new Set((ops?.failedJobs ?? []).map((j) => j.contentItemId));

  for (const job of ops?.failedJobs ?? []) {
    // One row per content item: its newest failure (the list is newest first).
    if (items.some((i) => i.kind === 'failed' && i.href === `/content/${job.contentItemId}`))
      continue;
    items.push({
      id: `failed:${job.jobId}`,
      kind: 'failed',
      priority: 10,
      title: job.contentTitle,
      projectName: job.projectName,
      reason: 'todo.reason.failed',
      action: 'todo.action.fix',
      href: `/content/${job.contentItemId}`,
      detail: job.errorCode ?? undefined,
      at: job.failedAt,
    });
  }
  for (const r of ops?.heldReservations ?? []) {
    items.push({
      id: `held:${r.id}`,
      kind: 'held',
      priority: 15,
      title: r.contentTitle,
      projectName: r.projectName,
      reason: 'todo.reason.held',
      action: 'todo.action.resolve',
      href: '/operations',
      detail: r.amountUsd,
      at: r.createdAt,
    });
  }
  for (const item of content) {
    const gate = GATES[item.status];
    if (gate) {
      items.push({
        id: `gate:${item.id}`,
        kind: 'gate',
        priority: gate.priority,
        title: item.title,
        projectName: item.projectName,
        reason: gate.reason,
        action: gate.action,
        href: `/content/${item.id}${gate.hash}`,
        gate: gate.gate,
        at: item.updatedAt,
      });
    } else if (item.status === 'needs_input') {
      items.push({
        id: `input:${item.id}`,
        kind: 'input',
        priority: 12,
        title: item.title,
        projectName: item.projectName,
        reason: 'todo.reason.input',
        action: 'todo.action.open',
        href: `/content/${item.id}`,
        at: item.updatedAt,
      });
    } else if (item.status === 'failed' && !failedContent.has(item.id)) {
      items.push({
        id: `failed:${item.id}`,
        kind: 'failed',
        priority: 11,
        title: item.title,
        projectName: item.projectName,
        reason: 'todo.reason.failed',
        action: 'todo.action.fix',
        href: `/content/${item.id}`,
        at: item.updatedAt,
      });
    }
  }
  for (const b of ops?.budgets ?? []) {
    if (!b.warning) continue;
    items.push({
      id: `budget:${b.projectId}`,
      kind: 'budget',
      priority: 30,
      title: b.projectName,
      projectName: b.projectName,
      reason: 'todo.reason.budget',
      action: 'todo.action.costs',
      href: `/projects/${b.projectId}/costs`,
      detail: b.limitUsd,
      at: ops?.generatedAt ?? new Date(0).toISOString(),
    });
  }
  items.sort((a, b) => a.priority - b.priority || b.at.localeCompare(a.at));
  return {
    items,
    running: content.filter((c) => isGenerating(c.status)),
    ready: content.filter((c) => isFinished(c.status)).slice(0, 5),
  };
}
