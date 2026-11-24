'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

import { NAV_ITEMS } from './nav-items';

/** The seven menu entries (redesign R-D1); `counts` adds a badge (e.g. open To-do items). */
export function SidebarNav(props: { readonly counts?: Readonly<Record<string, number>> }) {
  const path = usePathname();
  const t = useT();
  return (
    <nav className="nav-group" aria-label={t('nav.main')}>
      {NAV_ITEMS.map((entry) => {
        const count = props.counts?.[entry.href];
        return (
          <Link
            key={entry.href}
            href={entry.href}
            className="nav-item"
            aria-current={entry.match(path) ? 'page' : undefined}
            title={t(entry.label)}
          >
            <span className="nav-icon" aria-hidden="true">
              <Icon name={entry.icon} size={18} />
            </span>
            <span className="nav-text">{t(entry.label)}</span>
            {count !== undefined && count > 0 && (
              <span className="nav-count" aria-hidden="true">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
