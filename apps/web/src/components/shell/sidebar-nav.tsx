'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon, type IconName } from '@/components/icon';
import { t } from '@/lib/i18n';

interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly count?: number;
  /** Whether a pathname belongs to this entry. */
  readonly match: (path: string) => boolean;
}

const isContentWorkspace = (path: string) => /^\/content\/[^/]+/.test(path);

/** The section a pathname belongs to (breadcrumb label and active nav entry). */
export function sectionOf(path: string): string {
  if (path === '/') return 'Overview';
  if (path.startsWith('/projects')) return 'Projects';
  if (isContentWorkspace(path)) return 'Content workspace';
  if (path.startsWith('/content')) return 'Content library';
  if (path.startsWith('/masters')) return 'Content masters';
  if (path.startsWith('/pipeline')) return 'Production pipeline';
  if (path.startsWith('/assets')) return 'Asset library';
  if (path.startsWith('/operations')) return 'Operations';
  if (path.startsWith('/settings')) return 'Settings';
  return 'Workspace';
}

export function SidebarNav({ projectCount }: { readonly projectCount: number }) {
  const path = usePathname();
  const groups: readonly { readonly label: string; readonly entries: readonly NavEntry[] }[] = [
    {
      label: t('nav.workspace'),
      entries: [
        { href: '/', label: t('nav.overview'), icon: 'overview', match: (p) => p === '/' },
        {
          href: '/projects',
          label: t('nav.projects'),
          icon: 'projects',
          count: projectCount,
          match: (p) => p.startsWith('/projects'),
        },
        {
          href: '/content',
          label: t('nav.content'),
          icon: 'content',
          match: (p) => p === '/content',
        },
        {
          href: '/masters',
          label: t('nav.masters'),
          icon: 'masters',
          match: (p) => p.startsWith('/masters'),
        },
      ],
    },
    {
      label: t('nav.production'),
      entries: [
        {
          href: '/pipeline',
          label: t('nav.pipeline'),
          icon: 'pipeline',
          match: (p) => p.startsWith('/pipeline') || isContentWorkspace(p),
        },
        {
          href: '/assets',
          label: t('nav.assets'),
          icon: 'assets',
          match: (p) => p.startsWith('/assets'),
        },
        {
          href: '/operations',
          label: t('nav.operations'),
          icon: 'operations',
          match: (p) => p.startsWith('/operations'),
        },
      ],
    },
    {
      label: t('nav.workspaceSettings'),
      entries: [
        {
          href: '/settings',
          label: t('nav.settings'),
          icon: 'settings',
          match: (p) => p.startsWith('/settings'),
        },
      ],
    },
  ];

  return (
    <>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="nav-label">{group.label}</div>
          <nav className="nav-group" aria-label={group.label}>
            {group.entries.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="nav-item"
                aria-current={entry.match(path) ? 'page' : undefined}
                title={entry.label}
              >
                <span className="nav-icon" aria-hidden="true">
                  <Icon name={entry.icon} size={18} />
                </span>
                <span className="nav-text">{entry.label}</span>
                {entry.count !== undefined && (
                  <span className="nav-count" aria-hidden="true">
                    {entry.count}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      ))}
    </>
  );
}
