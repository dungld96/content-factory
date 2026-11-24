'use client';

import { useSyncExternalStore } from 'react';

import { useT } from '@/components/i18n-provider';

export interface CheckItem {
  readonly id: string;
  readonly label: string;
  /** Passed an automatic check: ticked from the start (R-D3). */
  readonly auto?: boolean;
}

/** Ticks per storage key, kept in localStorage and shared by every hook of the same key. */
const cache = new Map<string, readonly string[] | null>();
const listeners = new Set<() => void>();

function readTicks(key: string): readonly string[] | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  let value: readonly string[] | null;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    value = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    value = null;
  }
  cache.set(key, value);
  return value;
}

function writeTicks(key: string, ticks: readonly string[]): void {
  cache.set(key, ticks);
  try {
    window.localStorage.setItem(key, JSON.stringify(ticks));
  } catch {
    // Private mode or full storage: ticks last for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The reviewer's checklist (redesign R-D3): an aid, not a record. Items that passed an automatic
 * check start ticked; ticks are kept in this browser per version (`storageKey`), so leaving and
 * coming back keeps them. Nothing is sent to the API.
 */
export function useChecklist(storageKey: string, items: readonly CheckItem[]) {
  const saved = useSyncExternalStore(
    subscribe,
    () => readTicks(storageKey),
    () => null,
  );
  const auto = items.filter((i) => i.auto).map((i) => i.id);
  const checked: ReadonlySet<string> = new Set([...(saved ?? []), ...auto]);
  const save = (next: ReadonlySet<string>) => {
    writeTicks(storageKey, [...next]);
  };
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save(next);
  };
  const checkAll = () => {
    save(new Set(items.map((i) => i.id)));
  };
  const unchecked = items.filter((i) => !checked.has(i.id)).length;
  return { checked, toggle, checkAll, unchecked };
}

export function ReviewChecklist(props: {
  readonly items: readonly CheckItem[];
  readonly state: ReturnType<typeof useChecklist>;
}) {
  const t = useT();
  const { checked, toggle } = props.state;
  const done = props.items.filter((i) => checked.has(i.id)).length;
  return (
    <fieldset className="review-checklist">
      <legend className="sr-only">
        {t('review.checklist')} · {t('review.checked', { done, total: props.items.length })}
      </legend>
      <ul className="col">
        {props.items.map((item) => (
          <li key={item.id} className={checked.has(item.id) ? 'claim on' : 'claim'}>
            <label>
              <input
                type="checkbox"
                checked={checked.has(item.id)}
                onChange={() => {
                  toggle(item.id);
                }}
              />
              <span className="col claim-text">
                <b>{item.label}</b>
                {item.auto && <span className="t-12 muted">{t('review.auto')}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
