'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import { LanguageSwitch } from '@/components/language-switch';
import { projectInitials, projectSwatch } from '@/lib/project-swatch';

import { LogoutButton } from './logout-button';

/** Closes a popover on Escape, an outside click and navigation. */
function usePopover(ref: React.RefObject<HTMLDivElement | null>): {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
} {
  const path = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenOn(null);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenOn(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open, ref]);
  return {
    open,
    toggle: () => {
      setOpenOn(open ? null : path);
    },
    close: () => {
      setOpenOn(null);
    },
  };
}

/**
 * The project switcher under the brand (design canvas). Inside a project's pages it shows that
 * project; elsewhere "All projects". The menu jumps to a project.
 */
export function ProjectSwitch(props: {
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useT();
  const path = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const pop = usePopover(ref);
  const currentId = /^\/projects\/([^/]+)/.exec(path)?.[1];
  const current = props.projects.find((p) => p.id === currentId);
  return (
    <div className="proj-switch-wrap" ref={ref}>
      <button
        className="proj-switch"
        type="button"
        aria-expanded={pop.open}
        aria-haspopup="menu"
        onClick={pop.toggle}
      >
        <span
          className="sw"
          aria-hidden="true"
          style={current ? { background: projectSwatch(current.id) } : undefined}
        >
          {current ? projectInitials(current.name) : t('nav.allShort')}
        </span>
        <span className="proj-name">{current?.name ?? t('nav.allProjects')}</span>
        <span className="spacer" />
        <Icon name="chevronDown" />
      </button>
      {pop.open && (
        <div className="menu-pop" role="menu">
          <span className="mi hd">{t('nav.switchProject')}</span>
          <Link className="mi" role="menuitem" href="/projects" onClick={pop.close}>
            <span className="sw" aria-hidden="true">
              {t('nav.allShort')}
            </span>
            {t('nav.allProjects')}
          </Link>
          {props.projects.map((p) => (
            <Link
              key={p.id}
              className="mi"
              role="menuitem"
              href={`/projects/${p.id}`}
              onClick={pop.close}
            >
              <span className="sw" aria-hidden="true" style={{ background: projectSwatch(p.id) }}>
                {projectInitials(p.name)}
              </span>
              {p.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const THEME_COOKIE = 'acf_theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeScheme(listener: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

/** Light / dark switch (design canvas: the moon at the sidebar foot); remembered in a cookie. */
export function ThemeToggle(props: { readonly initial: 'light' | 'dark' | null }) {
  const t = useT();
  const [theme, setTheme] = useState<'light' | 'dark' | null>(props.initial);
  const systemDark = useSyncExternalStore(
    subscribeScheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
  const effective = theme ?? (systemDark ? 'dark' : 'light');
  const next = effective === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn icon ghost theme-toggle"
      aria-label={next === 'dark' ? t('nav.themeDark') : t('nav.themeLight')}
      title={next === 'dark' ? t('nav.themeDark') : t('nav.themeLight')}
      onClick={() => {
        document.documentElement.dataset['theme'] = next;
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        setTheme(next);
      }}
    >
      <Icon name={effective === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

/** The account row at the sidebar foot: avatar and name; the menu holds language and sign-out. */
export function AccountMenu(props: {
  readonly name: string;
  readonly email: string;
  readonly avatar: ReactNode;
  readonly theme: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const pop = usePopover(ref);
  return (
    <div className="me-wrap" ref={ref}>
      {pop.open && (
        <div className="menu-pop account-pop" role="dialog" aria-label={t('nav.account')}>
          <span className="mi hd">{props.email}</span>
          <div className="mi">
            <LanguageSwitch signedIn variant="light" />
          </div>
          <Link className="mi" href="/settings/profile" onClick={pop.close}>
            <Icon name="settings" />
            {t('nav.profile')}
          </Link>
          <div className="mi">
            <LogoutButton />
          </div>
        </div>
      )}
      <div className="me">
        <button
          type="button"
          className="me-button"
          aria-expanded={pop.open}
          aria-label={t('nav.accountOf', { name: props.name })}
          onClick={pop.toggle}
        >
          {props.avatar}
          <span className="me-name">{props.name}</span>
        </button>
        <span className="spacer" />
        {props.theme}
      </div>
    </div>
  );
}
