import 'server-only';

import { cache } from 'react';

import type { ContentItemDto, Page, ProjectDto } from '@acf/contracts';

import { apiGet, type ApiResult } from './api-server';

/** Upper bound on pages followed per list (100 items each): enough for the MVP pilot. */
const MAX_PAGES = 10;

export interface AllResult<T> {
  readonly items: T[];
  /** More items exist than were loaded (MAX_PAGES reached). */
  readonly truncated: boolean;
}

/** Follows `page.nextCursor` of a list endpoint. `path` must not carry `limit` or `cursor`. */
export async function apiGetAll<T>(path: string): Promise<ApiResult<AllResult<T>>> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const query: string = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result: ApiResult<Page<T>> = await apiGet<Page<T>>(`${path}${separator}${query}`);
    if (result.kind !== 'ok') return result;
    items.push(...result.data.data);
    cursor = result.data.page.nextCursor;
    if (!cursor) return { kind: 'ok', data: { items, truncated: false } };
  }
  return { kind: 'ok', data: { items, truncated: true } };
}

export interface WorkspaceContent extends ContentItemDto {
  readonly projectName: string;
}

export interface Workspace {
  readonly projects: ProjectDto[];
  /** Every active content item of every project, most recently updated first. */
  readonly content: WorkspaceContent[];
  readonly truncated: boolean;
}

/**
 * The caller's projects and their content. There is no workspace-level endpoint (the API is
 * project-scoped), so this reads each project's list; the MVP has a handful of projects.
 * Cached per request: the sidebar counts and the page share one read.
 */
export const loadWorkspace = cache(async (): Promise<ApiResult<Workspace>> => {
  const projects = await apiGetAll<ProjectDto>('/projects');
  if (projects.kind !== 'ok') return projects;
  const lists = await Promise.all(
    projects.data.items.map((p) => apiGetAll<ContentItemDto>(`/projects/${p.id}/content`)),
  );
  const content: WorkspaceContent[] = [];
  let truncated = projects.data.truncated;
  for (const [i, list] of lists.entries()) {
    const project = projects.data.items[i];
    if (!project) continue;
    if (list.kind === 'unauthenticated') return list;
    if (list.kind !== 'ok') return list;
    truncated ||= list.data.truncated;
    content.push(...list.data.items.map((item) => ({ ...item, projectName: project.name })));
  }
  content.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { kind: 'ok', data: { projects: projects.data.items, content, truncated } };
});
