'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/icon';
import { t, type MessageKey } from '@/lib/i18n';

const BOTTOM: readonly {
  readonly href: string;
  readonly label: MessageKey;
  readonly icon: IconName;
  readonly match: (p: string) => boolean;
}[] = [
  { href: '/', label: 'nav.overview', icon: 'overview', match: (p) => p === '/' },
  {
    href: '/content',
    label: 'nav.contentShort',
    icon: 'content',
    match: (p) => p.startsWith('/content') || p.startsWith('/pipeline'),
  },
  { href: '/assets', label: 'nav.library', icon: 'assets', match: (p) => p.startsWith('/assets') },
  {
    href: '/operations',
    label: 'nav.operations',
    icon: 'operations',
    match: (p) => p.startsWith('/operations'),
  },
];

/**
 * The studio frame (UX review U4). On wide screens the sidebar is always visible. Below 760 px
 * it becomes a drawer opened from the top bar's menu button, and a bottom bar holds the four most
 * used destinations. The drawer closes on navigation and with Escape.
 */
export function AppShell(props: { readonly sidebar: ReactNode; readonly children: ReactNode }) {
  const path = usePathname();
  // The drawer belongs to the page it was opened on: navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const setOpen = (value: boolean | ((was: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(open) : value;
    setOpenOn(next ? path : null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenOn(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={open ? 'app nav-open' : 'app'}>
      <button
        type="button"
        className="menu-button"
        aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
        aria-expanded={open}
        aria-controls="studio-sidebar"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Icon name={open ? 'cancel' : 'menu'} size={22} />
      </button>
      <aside className="sidebar" id="studio-sidebar">
        {props.sidebar}
      </aside>
      {open && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label={t('nav.closeMenu')}
          onClick={() => {
            setOpen(false);
          }}
        />
      )}
      {props.children}
      <nav className="bottom-nav" aria-label={t('nav.menu')}>
        {BOTTOM.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={item.match(path) ? 'active' : undefined}
            aria-current={item.match(path) ? 'page' : undefined}
          >
            <Icon name={item.icon} size={20} />
            <span>{t(item.label)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
