'use client';

import type { ActiveJobsDto, JobChangesDto, LiveJobEventDto } from '@acf/contracts';

import {
  applyEvent,
  INITIAL,
  pollDelay,
  withSnapshot,
  type LiveState,
  type LiveTransport,
} from './state';

/**
 * One live connection per browser (redesign R-D5, package §5). The tab holding the Web Lock
 * `acf-live` is the leader: it keeps the only EventSource (or the polling fallback) and repeats
 * every message on the BroadcastChannel `acf-live`; other tabs only listen. When the leader tab
 * closes, another tab gets the lock and resumes from the last cursor. With every tab hidden for
 * two minutes the leader pauses and resumes by cursor when one becomes visible again.
 */
type Message =
  | { readonly type: 'event'; readonly event: LiveJobEventDto }
  | { readonly type: 'snapshot'; readonly snapshot: ActiveJobsDto }
  | { readonly type: 'resync' }
  | { readonly type: 'transport'; readonly transport: LiveTransport }
  | { readonly type: 'visible' }
  | { readonly type: 'hello' };

const CHANNEL = 'acf-live';
const HIDDEN_PAUSE_MS = 2 * 60_000;
const SILENCE_MS = 60_000;
const SSE_FAILURES_BEFORE_POLLING = 3;
const RETRY_SSE_MS = 5 * 60_000;

let state: LiveState = INITIAL;
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: LiveJobEventDto) => void>();
const resyncListeners = new Set<() => void>();
let started = false;
let channel: BroadcastChannel | null = null;

function set(next: LiveState) {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getState = (): LiveState => state;
export const getServerState = (): LiveState => INITIAL;

/** Called for every new job event (after the store applied it). */
export function onJobEvent(listener: (event: LiveJobEventDto) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}
/** Called when the gap was too large: reload what the page shows. */
export function onResync(listener: () => void): () => void {
  resyncListeners.add(listener);
  return () => resyncListeners.delete(listener);
}

function receive(message: Message) {
  switch (message.type) {
    case 'event': {
      const next = applyEvent(state, message.event);
      if (next === state) return;
      set(next);
      for (const l of eventListeners) l(message.event);
      return;
    }
    case 'snapshot':
      set(withSnapshot(state, message.snapshot));
      return;
    case 'resync':
      for (const l of resyncListeners) l();
      return;
    case 'transport':
      set({ ...state, transport: message.transport });
      return;
    default:
      return;
  }
}

/** Applies locally and tells the other tabs. */
function publish(message: Message) {
  receive(message);
  channel?.postMessage(message);
}

async function fetchJson(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`/api/v1${path}`, { cache: 'no-store', headers });
  return res;
}

/** The leader's work while it holds the lock; resolves only when the tab goes away. */
async function lead(): Promise<void> {
  let lastVisible = Date.now();
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retrySseTimer: ReturnType<typeof setTimeout> | undefined;
  let sseFailures = 0;
  let pollFailures = 0;
  let etag: string | null = null;
  let lastMessage = Date.now();

  channel?.addEventListener('message', (e: MessageEvent<Message>) => {
    if (e.data.type === 'visible') {
      lastVisible = Date.now();
      if (state.transport === 'paused') void resume();
    }
  });
  const visibleNow = () => {
    if (document.visibilityState === 'visible') {
      lastVisible = Date.now();
      if (state.transport === 'paused') void resume();
    }
  };
  document.addEventListener('visibilitychange', visibleNow);

  async function snapshot(): Promise<boolean> {
    try {
      const res = await fetchJson('/jobs/active');
      if (!res.ok) return false;
      publish({ type: 'snapshot', snapshot: (await res.json()) as ActiveJobsDto });
      return true;
    } catch {
      return false;
    }
  }

  function stopAll() {
    source?.close();
    source = null;
    clearTimeout(pollTimer);
    clearTimeout(retrySseTimer);
  }

  function openSse() {
    stopAll();
    publish({ type: 'transport', transport: 'connecting' });
    const since = state.cursor ? `?since=${encodeURIComponent(state.cursor)}` : '';
    source = new EventSource(`/api/v1/events${since}`);
    lastMessage = Date.now();
    source.addEventListener('open', () => {
      sseFailures = 0;
      publish({ type: 'transport', transport: 'sse' });
    });
    source.addEventListener('job', (e: MessageEvent<string>) => {
      lastMessage = Date.now();
      publish({ type: 'event', event: JSON.parse(e.data) as LiveJobEventDto });
    });
    source.addEventListener('ping', () => {
      lastMessage = Date.now();
    });
    source.addEventListener('ready', () => {
      lastMessage = Date.now();
    });
    source.addEventListener('resync', () => {
      lastMessage = Date.now();
      void snapshot().then(() => {
        publish({ type: 'resync' });
      });
    });
    source.addEventListener('error', () => {
      sseFailures += 1;
      if (sseFailures >= SSE_FAILURES_BEFORE_POLLING) startPolling();
    });
  }

  function startPolling() {
    stopAll();
    publish({ type: 'transport', transport: 'polling' });
    retrySseTimer = setTimeout(openSse, RETRY_SSE_MS);
    const tick = async () => {
      if (!state.cursor && !(await snapshot())) {
        pollFailures += 1;
      } else if (state.cursor) {
        try {
          const res = await fetchJson(
            `/jobs/changes?since=${encodeURIComponent(state.cursor)}`,
            etag ? { 'if-none-match': etag } : {},
          );
          if (res.status === 304) {
            pollFailures = 0;
          } else if (res.ok) {
            pollFailures = 0;
            etag = res.headers.get('etag');
            const body = (await res.json()) as JobChangesDto;
            if (body.resync) {
              await snapshot();
              publish({ type: 'resync' });
            } else {
              for (const event of body.events) publish({ type: 'event', event });
            }
          } else {
            pollFailures += 1;
          }
        } catch {
          pollFailures += 1;
        }
      }
      pollTimer = setTimeout(
        () => void tick(),
        pollDelay({
          activeJobs: state.active.length,
          hidden: document.visibilityState === 'hidden',
          failures: pollFailures,
        }),
      );
    };
    void tick();
  }

  async function resume() {
    await snapshot();
    openSse();
  }

  const silenceTimer = setInterval(() => {
    const allHidden =
      document.visibilityState === 'hidden' && Date.now() - lastVisible > HIDDEN_PAUSE_MS;
    if (allHidden && state.transport !== 'paused') {
      stopAll();
      publish({ type: 'transport', transport: 'paused' });
      return;
    }
    // No message (not even a heartbeat) for a minute: the stream is stuck behind a proxy.
    if (state.transport === 'sse' && Date.now() - lastMessage > SILENCE_MS) startPolling();
  }, 10_000);

  await snapshot();
  if (typeof EventSource === 'undefined') startPolling();
  else openSse();

  // Hold the lock until the page is closed.
  await new Promise<void>((resolve) => {
    window.addEventListener('pagehide', () => {
      clearInterval(silenceTimer);
      document.removeEventListener('visibilitychange', visibleNow);
      stopAll();
      resolve();
    });
  });
}

/** Starts live tracking once per tab (idempotent). */
export function startLive(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.addEventListener('message', (e: MessageEvent<Message>) => {
      if (e.data.type === 'hello') {
        // A new tab: give it the current picture.
        if (state.cursor) {
          channel?.postMessage({
            type: 'snapshot',
            snapshot: { cursor: state.cursor, jobs: [...state.active] },
          } satisfies Message);
          channel?.postMessage({ type: 'transport', transport: state.transport } satisfies Message);
        }
        return;
      }
      receive(e.data);
    });
    channel.postMessage({ type: 'hello' } satisfies Message);
    const announce = () => {
      if (document.visibilityState === 'visible') {
        channel?.postMessage({ type: 'visible' } satisfies Message);
      }
    };
    document.addEventListener('visibilitychange', announce);
    setInterval(announce, 30_000);
  }
  if (typeof navigator !== 'undefined' && 'locks' in navigator && channel) {
    void navigator.locks.request(CHANNEL, () => lead());
  } else {
    // No Web Locks or no BroadcastChannel: this tab keeps its own connection.
    void lead();
  }
}
