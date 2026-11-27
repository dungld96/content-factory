'use client';

import { useSyncExternalStore } from 'react';

import { useLocale } from '@/components/i18n-provider';
import { intlLocale, type Locale } from '@/lib/i18n';

const subscribe = (): (() => void) => () => undefined;

/**
 * True after hydration, false during server render and the hydration pass. React re-renders
 * with the client snapshot once hydration completes, so the formatted text replaces the ISO
 * string without a hydration mismatch.
 */
export function useHydrated(): boolean {
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
  const locale = useLocale();
  return <time dateTime={iso}>{hydrated ? formatLocal(iso, locale) : iso}</time>;
}

/**
 * "21 Nov 2026, 14:52" / "21 thg 11, 2026, 14:52": the interface language, the viewer's time
 * zone, 24-hour clock (UX review U3, R-D6).
 */
export function formatLocal(iso: string, locale?: Locale): string {
  return new Intl.DateTimeFormat(locale ? intlLocale(locale) : undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** A clock that ticks once a minute, shared by every RelativeTime (null on the server). */
let clockNow = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(listener: () => void): () => void {
  if (clockListeners.size === 0) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, 60_000);
  }
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) clearInterval(clockTimer);
  };
}

function useNow(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow || null,
    () => null,
  );
}

/** "12 minutes ago" in the viewer's locale; the full local date is in the tooltip. */
export function RelativeTime({ iso }: { readonly iso: string }) {
  const now = useNow();
  const locale = useLocale();
  if (now === null) return <time dateTime={iso}>{iso.slice(0, 10)}</time>;
  const seconds = (new Date(iso).getTime() - now) / 1000;
  const format = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size);
  const text = unit
    ? format.format(Math.round(seconds / unit[1]), unit[0])
    : format.format(0, 'minute');
  return (
    <time dateTime={iso} title={formatLocal(iso, locale)}>
      {text}
    </time>
  );
}
