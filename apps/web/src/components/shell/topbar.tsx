'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';

import { Icon } from '@/components/icon';

import { sectionOf } from './sidebar-nav';

const noSubscription = (): (() => void) => () => undefined;

/** Breadcrumb and content search (⌘K / Ctrl+K focuses it; Enter opens the content library). */
export function Topbar() {
  const path = usePathname();
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
    router.push(q ? `/content?q=${encodeURIComponent(q)}` : '/content');
  }

  return (
    <header className="topbar">
      <div className="crumb">
        <span className="crumb-root">Workspace</span>
        <span className="crumb-sep" aria-hidden="true">
          /
        </span>
        <b>{sectionOf(path)}</b>
      </div>
      <div className="top-spacer" />
      <form className="search" role="search" onSubmit={search}>
        <Icon name="search" />
        <input
          ref={input}
          // Re-mount when the URL query changes so the field shows the active search.
          key={path === '/content' ? (params.get('q') ?? '') : ''}
          name="q"
          type="search"
          placeholder="Search content…"
          aria-label="Search content"
          defaultValue={path === '/content' ? (params.get('q') ?? '') : ''}
        />
        <kbd aria-hidden="true">{shortcut}</kbd>
      </form>
    </header>
  );
}
