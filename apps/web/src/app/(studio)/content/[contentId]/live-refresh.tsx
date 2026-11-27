'use client';

import { useLiveRefresh } from '@/lib/live/hooks';

/**
 * Re-renders the workspace when one of its jobs changes state (redesign R-D5): driven by the
 * browser's one live connection, instead of a refresh every two seconds while generating.
 */
export function LiveRefresh({ contentId }: { readonly contentId: string }) {
  useLiveRefresh(contentId);
  return null;
}
