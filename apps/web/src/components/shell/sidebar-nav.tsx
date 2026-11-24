'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

import { NAV_GROUPS, NAV_ITEMS } from './nav-items';

/**
 * The seven menu entries (redesign R-D1) in the canvas's three groups. `counts` adds a badge per
 * entry (open To-do items, productions in progress); `alert` marks the To-do badge as urgent.
 */
export function SidebarNav(props: { readonly counts?: Readonly<Record<string, number>> }) {
  const path = usePathname();
  const t = useT();
  return (
    <nav className="nav-groups" aria-label={t('nav.main')}>
      {NAV_GROUPS.map((group) => (
        <div key={group} className="nav-group" role="group" aria-labelledby={`nav-${group}`}>
          <p className="nav-label" id={`nav-${group}`}>
            {t(`nav.group.${group}`)}
          </p>
          {NAV_ITEMS.filter((entry) => entry.group === group).map((entry) => {
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
                  <span
                    className={entry.href === '/' ? 'nav-count urgent' : 'nav-count'}
                    aria-label={t('nav.countLabel', { count })}
                  >
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
