'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
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
      label: 'Workspace',
      entries: [
        { href: '/', label: 'Overview', icon: '◫', match: (p) => p === '/' },
        {
          href: '/projects',
          label: 'Projects',
          icon: '▦',
          count: projectCount,
          match: (p) => p.startsWith('/projects'),
        },
        {
          href: '/content',
          label: 'Content library',
          icon: '▤',
          match: (p) => p === '/content',
        },
        {
          href: '/masters',
          label: 'Content masters',
          icon: '◈',
          match: (p) => p.startsWith('/masters'),
        },
      ],
    },
    {
      label: 'Production',
      entries: [
        {
          href: '/pipeline',
          label: 'Production pipeline',
          icon: '⌘',
          match: (p) => p.startsWith('/pipeline') || isContentWorkspace(p),
        },
        {
          href: '/assets',
          label: 'Asset library',
          icon: '▧',
          match: (p) => p.startsWith('/assets'),
        },
        {
          href: '/operations',
          label: 'Operations',
          icon: '◉',
          match: (p) => p.startsWith('/operations'),
        },
      ],
    },
    {
      label: 'Workspace settings',
      entries: [
        {
          href: '/settings',
          label: 'Settings',
          icon: '⚙',
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
                  {entry.icon}
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
