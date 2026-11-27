import type { IconName } from '@/components/icon';
import type { MessageKey } from '@/lib/i18n';

export type NavGroup = 'work' | 'resources' | 'control';

export const NAV_GROUPS: readonly NavGroup[] = ['work', 'resources', 'control'];

export interface NavItem {
  readonly href: string;
  readonly label: MessageKey;
  /** Short label for the phone bottom bar. */
  readonly short: MessageKey;
  readonly icon: IconName;
  /** Menu group (design canvas: Work, Resources, Control). */
  readonly group: NavGroup;
  /** Whether a pathname belongs to this entry. */
  readonly match: (path: string) => boolean;
}

const isContentWorkspace = (path: string) => /^\/content\/[^/]+/.test(path);

/** The seven task-based destinations (redesign R-D1, R-D2), in menu order. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/',
    group: 'work',
    label: 'nav.todo',
    short: 'nav.todoShort',
    icon: 'todoList',
    match: (p) => p === '/',
  },
  {
    href: '/productions',
    group: 'work',
    label: 'nav.productions',
    short: 'nav.productions',
    icon: 'film',
    match: (p) => p.startsWith('/productions') || isContentWorkspace(p) || p.startsWith('/masters'),
  },
  {
    href: '/projects',
    group: 'work',
    label: 'nav.projects',
    short: 'nav.projects',
    icon: 'folder',
    match: (p) => p.startsWith('/projects'),
  },
  {
    href: '/assets',
    group: 'resources',
    label: 'nav.library',
    short: 'nav.library',
    icon: 'image',
    match: (p) => p.startsWith('/assets'),
  },
  {
    href: '/costs',
    group: 'control',
    label: 'nav.costs',
    short: 'nav.costs',
    icon: 'costs',
    match: (p) => p.startsWith('/costs'),
  },
  {
    href: '/operations',
    group: 'control',
    label: 'nav.operations',
    short: 'nav.operationsShort',
    icon: 'operations',
    match: (p) => p.startsWith('/operations'),
  },
  {
    href: '/settings',
    group: 'control',
    label: 'nav.settings',
    short: 'nav.settings',
    icon: 'sliders',
    match: (p) => p.startsWith('/settings'),
  },
];

/** The phone bottom bar: four destinations plus the menu button (package §2). */
export const BOTTOM_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) =>
  ['/', '/productions', '/assets', '/operations'].includes(item.href),
);

/** The breadcrumb label of a pathname. */
export function sectionOf(path: string): MessageKey {
  if (isContentWorkspace(path)) return 'nav.workspaceSection';
  if (path.startsWith('/masters')) return 'nav.masters';
  return (
    NAV_ITEMS.find((item) => item.href !== '/' && item.match(path))?.label ??
    (path === '/' ? 'nav.todo' : 'nav.workspace')
  );
}
