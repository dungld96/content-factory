'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (): (() => void) => () => undefined;

/**
 * True after hydration, false during server render and the hydration pass. React re-renders
 * with the client snapshot once hydration completes, so the formatted text replaces the ISO
 * string without a hydration mismatch.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * Renders a UTC ISO timestamp in the viewer's locale and timezone (CLAUDE.md §5).
 * The server render (and the first client render) shows the ISO string; the browser swaps in
 * the localized text right after hydration.
 */
export function LocalTime({ iso }: { readonly iso: string }) {
  const hydrated = useHydrated();
  return <time dateTime={iso}>{hydrated ? new Date(iso).toLocaleString() : iso}</time>;
}
