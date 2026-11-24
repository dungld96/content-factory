'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useT } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n';

/**
 * Sections of a project (redesign R-D1): content, brand, masters, costs and its library. Masters
 * and the library are workspace pages filtered to the project.
 */
export function ProjectTabs({ projectId }: { readonly projectId: string }) {
  const t = useT();
  const path = usePathname();
  const base = `/projects/${projectId}`;
  const tabs: readonly { href: string; label: MessageKey; current: boolean }[] = [
    { href: base, label: 'project.tab.overview', current: path === base },
    {
      href: `${base}/brand`,
      label: 'project.tab.brand',
      current: path.startsWith(`${base}/brand`),
    },
    { href: `/masters?project=${projectId}`, label: 'project.tab.masters', current: false },
    {
      href: `${base}/costs`,
      label: 'project.tab.costs',
      current: path.startsWith(`${base}/costs`),
    },
    { href: `/assets?project=${projectId}`, label: 'project.tab.library', current: false },
  ];
  return (
    <nav className="page-tabs" aria-label={t('project.tabs')}>
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={tab.current ? 'page' : undefined}>
          {t(tab.label)}
        </Link>
      ))}
    </nav>
  );
}
