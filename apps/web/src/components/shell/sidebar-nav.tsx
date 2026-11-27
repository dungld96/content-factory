'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

import { NAV_GROUPS, NAV_ITEMS } from './nav-items';

/**
 * The seven menu entries (redesign R-D1) in the canvas's three groups. `counts` adds a badge per
 * entry: amber for To-do (decisions waiting), plain for the others.
 */
export function SidebarNav(props: { readonly counts?: Readonly<Record<string, number>> }) {
  const path = usePathname();
  const t = useT();
  return (
    <nav className="side-nav" aria-label={t('nav.main')}>
      {NAV_GROUPS.map((group) => (
        <Fragment key={group}>
          <span className="nav-label">{t(`nav.group.${group}`)}</span>
          {NAV_ITEMS.filter((entry) => entry.group === group).map((entry) => {
            const count = props.counts?.[entry.href];
            const on = entry.match(path);
            return (
              <Link
                key={entry.href}
                href={entry.href}
                className={on ? 'nav-item on' : 'nav-item'}
                aria-current={on ? 'page' : undefined}
              >
                <Icon name={entry.icon} size={20} />
                <span className="nav-text">{t(entry.label)}</span>
                {count !== undefined && count > 0 && (
                  <span
                    className={entry.href === '/' ? 'count' : 'count plain'}
                    aria-label={t('nav.countLabel', { count })}
                  >
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
