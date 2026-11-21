'use client';

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

/** Former tabs, now stages of the Scenes tab (UX review U1): old links keep working. */
const STAGE_ALIASES: ReadonlySet<string> = new Set(['keyframes', 'clips', 'voiceover']);

export interface WorkspaceTab {
  readonly id: string;
  readonly label: string;
  readonly badge?: string | undefined;
  readonly panel: ReactNode;
}

/**
 * Tabs of the content workspace. Every panel stays mounted (hidden when inactive) so editors and
 * running-job polls survive a tab switch. The active tab is mirrored in the URL hash (#storyboard),
 * so a reload or a `#activity` link selects it.
 */
export function WorkspaceTabs(props: {
  readonly tabs: readonly WorkspaceTab[];
  readonly initial: string;
}) {
  const { tabs } = props;
  const [active, setActive] = useState(props.initial);

  useEffect(() => {
    const fromHash = () => {
      // `#scenes?filter=failed` links carry options; stage names open the Scenes tab.
      const raw = window.location.hash.slice(1).split('?')[0] ?? '';
      const id = STAGE_ALIASES.has(raw) ? 'scenes' : raw;
      if (tabs.some((t) => t.id === id)) setActive(id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => {
      window.removeEventListener('hashchange', fromHash);
    };
  }, [tabs]);

  // Phones (UX review U4): keep the active tab in view in the scrolling tab row.
  useEffect(() => {
    document
      .getElementById(`tab-${active}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  function select(id: string) {
    setActive(id);
    window.history.replaceState(null, '', `#${id}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((t) => t.id === active);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) {
      select(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Content workspace" onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab.id === active}
            aria-controls={`panel-${tab.id}`}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => {
              select(tab.id);
            }}
          >
            {tab.label}
            {tab.badge && <span className="chip-count">{tab.badge}</span>}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}
