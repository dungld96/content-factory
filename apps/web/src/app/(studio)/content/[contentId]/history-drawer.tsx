'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

/**
 * Activity and version history as a drawer (redesign R3) instead of a tab. `#activity` links
 * (e.g. from render blockers) open it. The content mounts only while open.
 */
export function HistoryDrawer(props: { readonly children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash.startsWith('#activity')) setOpen(true);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => {
      window.removeEventListener('hashchange', fromHash);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-controls="history-drawer"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Icon name="history" /> {t('ws.history')}
      </button>
      {open && (
        <>
          <button
            type="button"
            className="drawer-backdrop"
            aria-label={t('common.close')}
            onClick={() => {
              setOpen(false);
            }}
          />
          <aside
            id="history-drawer"
            className="drawer"
            role="dialog"
            aria-modal="false"
            aria-label={t('ws.historyTitle')}
          >
            <div className="drawer-head">
              <h2>{t('ws.historyTitle')}</h2>
              <button
                type="button"
                className="btn small ghost"
                aria-label={t('common.close')}
                onClick={() => {
                  setOpen(false);
                }}
              >
                <Icon name="cancel" />
              </button>
            </div>
            {props.children}
          </aside>
        </>
      )}
    </>
  );
}
