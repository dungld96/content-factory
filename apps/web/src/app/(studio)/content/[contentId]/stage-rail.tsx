'use client';

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';

/** Former tabs, now stages of the Scenes tab (UX review U1): old links keep working. */
const STAGE_ALIASES: ReadonlySet<string> = new Set(['keyframes', 'clips', 'voiceover']);

export type StageState = 'done' | 'current' | 'todo' | 'locked';

export interface WorkspaceStage {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly state: StageState;
  /** Approval gate of this stage ("Gate 1"), when it has one. */
  readonly gate?: string | undefined;
  readonly badge?: string | undefined;
  readonly panel: ReactNode;
}

/**
 * The stage rail (redesign R3): progress and navigation in one control, replacing the stepper and
 * the tabs. Every panel stays mounted (hidden when inactive) so editors and live updates survive
 * a switch. The active stage is mirrored in the URL hash (#storyboard), so a reload or a link
 * selects it; `#activity` opens the history drawer instead (see HistoryDrawer).
 */
export function StageRail(props: {
  readonly stages: readonly WorkspaceStage[];
  readonly initial: string;
}) {
  const t = useT();
  const { stages } = props;
  const [active, setActive] = useState(props.initial);

  useEffect(() => {
    const fromHash = () => {
      const raw = window.location.hash.slice(1).split('?')[0] ?? '';
      const id = STAGE_ALIASES.has(raw) ? 'scenes' : raw;
      if (stages.some((s) => s.id === id)) setActive(id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => {
      window.removeEventListener('hashchange', fromHash);
    };
  }, [stages]);

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
    const index = stages.findIndex((s) => s.id === active);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = stages[(index + step + stages.length) % stages.length];
    if (next) {
      select(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  }

  const current = stages.findIndex((s) => s.state === 'current');
  const currentStage = stages[current];
  return (
    <>
      <p className="stage-compact" aria-hidden="true">
        {currentStage
          ? t('ws.stepOf', {
              current: current + 1,
              total: stages.length,
              name: currentStage.label,
            })
          : t('ws.allDone')}
      </p>
      <div className="stage-rail" role="tablist" aria-label={t('ws.stages')} onKeyDown={onKeyDown}>
        {stages.map((stage, i) => (
          <button
            key={stage.id}
            id={`tab-${stage.id}`}
            type="button"
            role="tab"
            className={`stage ${stage.state}`}
            aria-selected={stage.id === active}
            aria-controls={`panel-${stage.id}`}
            tabIndex={stage.id === active ? 0 : -1}
            onClick={() => {
              select(stage.id);
            }}
          >
            <span className="stage-circle" aria-hidden="true">
              {stage.state === 'done' ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span className="stage-text">
              <b>
                {stage.label}
                {stage.badge && <span className="chip-count">{stage.badge}</span>}
              </b>
              <small>
                {stage.gate && <span className="stage-gate">{stage.gate}</span>}
                {stage.note}
              </small>
            </span>
          </button>
        ))}
      </div>
      {stages.map((stage) => (
        <div
          key={stage.id}
          id={`panel-${stage.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${stage.id}`}
          hidden={stage.id !== active}
        >
          {stage.panel}
        </div>
      ))}
    </>
  );
}
