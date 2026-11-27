'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

import type { LiveJobEventDto } from '@acf/contracts';

import type { LiveState } from './state';
import { getServerState, getState, onJobEvent, onResync, subscribe } from './store';

export function useLive(): LiveState {
  return useSyncExternalStore(subscribe, getState, getServerState);
}

/**
 * Re-renders the server data of a page when a job of `contentItemId` (or any job, without one)
 * changes state: one debounced `router.refresh()` per burst of events, instead of polling.
 */
export function useLiveRefresh(
  contentItemId?: string,
  filter?: (event: LiveJobEventDto) => boolean,
): void {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        router.refresh();
      }, 400);
    };
    const offEvent = onJobEvent((event) => {
      if (contentItemId && event.contentItemId !== contentItemId) return;
      if (filter && !filter(event)) return;
      schedule();
    });
    const offResync = onResync(schedule);
    return () => {
      clearTimeout(timer);
      offEvent();
      offResync();
    };
  }, [contentItemId, filter, router]);
}
