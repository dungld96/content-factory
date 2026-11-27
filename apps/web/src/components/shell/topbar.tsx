'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

import { JobsTray } from './jobs-tray';
import { sectionOf } from './nav-items';
import { useCrumbs } from './page-crumbs';

/** Pages whose topbar shows their own actions instead of search, jobs and New content. */
const OWN_ACTIONS: ReadonlySet<string> = new Set(['/productions/new']);

const noSubscription = (): (() => void) => () => undefined;

/**
 * The topbar of the design canvas: breadcrumb, search (⌘K / Ctrl+K focuses it; Enter opens
 * Productions), the running-jobs pill and New content.
 */
export function Topbar() {
  const path = usePathname();
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const pageCrumbs = useCrumbs();
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

  const own = OWN_ACTIONS.has(path);
  const crumbs = pageCrumbs ?? [{ label: t(sectionOf(path)) }];

  return (
    <header className="topbar">
      <nav className="crumbs" aria-label={t('nav.breadcrumb')}>
        {crumbs.map((c, i) => (
          <Fragment key={`${c.label}-${String(i)}`}>
            {i > 0 && <Icon name="chevronRight" size={14} />}
            {c.href && i < crumbs.length - 1 ? (
              <Link href={c.href}>{c.label}</Link>
            ) : (
              <b>{c.label}</b>
            )}
          </Fragment>
        ))}
      </nav>
      <span className="spacer" />
      {/* Pages with their own topbar actions (New content) render them here. */}
      <div id="topbar-slot" className="row topbar-slot" />
      {!own && (
        <>
          <form className="cmdk" role="search" onSubmit={search}>
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
          <Link className="btn primary topbar-new" href="/productions/new">
            <Icon name="plus" />
            <span>{t('form.newContent')}</span>
          </Link>
        </>
      )}
    </header>
  );
}
