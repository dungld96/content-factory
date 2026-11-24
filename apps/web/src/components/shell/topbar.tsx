'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

import { JobsTray } from './jobs-tray';
import { sectionOf } from './nav-items';

const noSubscription = (): (() => void) => () => undefined;

/** Breadcrumb and content search (⌘K / Ctrl+K focuses it; Enter opens Productions). */
export function Topbar() {
  const path = usePathname();
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  // Ctrl K on Windows and Linux (most operators), ⌘ K on a Mac; decided after hydration.
  const isMac = useSyncExternalStore(
    noSubscription,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => false,
  );
  const shortcut = isMac ? '⌘ K' : 'Ctrl K';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function search(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const q = input.current?.value.trim() ?? '';
    router.push(q ? `/productions?q=${encodeURIComponent(q)}` : '/productions');
  }

  return (
    <header className="topbar">
      <div className="crumb">
        <span className="crumb-root">{t('nav.workspace')}</span>
        <span className="crumb-sep" aria-hidden="true">
          /
        </span>
        <b>{t(sectionOf(path))}</b>
      </div>
      <div className="top-spacer" />
      <form className="search" role="search" onSubmit={search}>
        <Icon name="search" />
        <input
          ref={input}
          // Re-mount when the URL query changes so the field shows the active search.
          key={path === '/productions' ? (params.get('q') ?? '') : ''}
          name="q"
          type="search"
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          defaultValue={path === '/productions' ? (params.get('q') ?? '') : ''}
        />
        <kbd aria-hidden="true">{shortcut}</kbd>
      </form>
      <JobsTray />
    </header>
  );
}
