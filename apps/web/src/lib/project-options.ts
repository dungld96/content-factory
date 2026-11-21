import type { ProjectDto } from '@acf/contracts';

import type { ProjectOption } from '@/components/forms';

/** Active projects the caller can create content in (editors and owners). */
export function writableProjects(projects: readonly ProjectDto[]): ProjectOption[] {
  return projects
    .filter((p) => p.role !== 'viewer' && p.archivedAt === null)
    .map((p) => ({ id: p.id, name: p.name, defaultLanguage: p.defaultLanguage }));
}
