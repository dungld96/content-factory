'use client';

/**
 * Renders a UTC ISO timestamp in the viewer's locale and timezone (CLAUDE.md §5).
 * The server render shows the ISO string; the browser replaces it after hydration.
 */
export function LocalTime({ iso }: { readonly iso: string }) {
  const formatted = typeof window === 'undefined' ? iso : new Date(iso).toLocaleString();
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {formatted}
    </time>
  );
}
