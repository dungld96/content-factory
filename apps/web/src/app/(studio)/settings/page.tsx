import { redirect } from 'next/navigation';

import { param, type SearchParams } from '@/lib/content-filters';

export const dynamic = 'force-dynamic';

const KNOWN = new Set([
  'general',
  'profile',
  'budgets',
  'voices',
  'ai',
  'models',
  'activity',
  'system',
]);

/** `/settings` and the former `?section=` links open a section route (redesign R6). */
export default async function SettingsPage(props: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const query = await props.searchParams;
  const section = param(query, 'section');
  const project = param(query, 'project');
  const target = section && KNOWN.has(section) ? section : 'general';
  redirect(`/settings/${target}${project ? `?project=${encodeURIComponent(project)}` : ''}`);
}
