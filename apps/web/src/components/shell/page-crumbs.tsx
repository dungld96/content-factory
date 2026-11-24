'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * The topbar breadcrumb of the current page (design canvas: "Productions › Vitamin C serum
 * myths"). A page renders `<PageCrumbs items=… />`; the topbar reads the latest one. Pages without
 * it get their menu section as the only crumb.
 */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

let current: readonly Crumb[] | null = null;
const listeners = new Set<() => void>();

function publish(items: readonly Crumb[] | null) {
  current = items;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCrumbs(): readonly Crumb[] | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

export function PageCrumbs(props: { readonly items: readonly Crumb[] }) {
  const key = JSON.stringify(props.items);
  useEffect(() => {
    publish(JSON.parse(key) as Crumb[]);
    return () => {
      publish(null);
    };
  }, [key]);
  return null;
}
