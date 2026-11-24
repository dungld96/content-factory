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
  /** Shown between the rail and the active panel (the Next-step bar, design canvas). */
  readonly afterRail?: ReactNode;
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
      <div className="rail" role="tablist" aria-label={t('ws.stages')} onKeyDown={onKeyDown}>
        {stages.map((stage) => (
          <button
            key={stage.id}
            id={`tab-${stage.id}`}
            type="button"
            role="tab"
            className={
              stage.state === 'done'
                ? 'done'
                : stage.state === 'current'
                  ? 'now'
                  : stage.state === 'locked'
                    ? 'locked'
                    : undefined
            }
            aria-selected={stage.id === active}
            aria-controls={`panel-${stage.id}`}
            tabIndex={stage.id === active ? 0 : -1}
            onClick={() => {
              select(stage.id);
            }}
          >
            <span className="st">
              <span className="mk" aria-hidden="true">
                {stage.state === 'done' ? (
                  <Icon name="check" size={11} />
                ) : stage.state === 'current' ? (
                  <Icon name="resume" size={11} />
                ) : null}
              </span>
              {stage.label}
              {stage.gate && (
                <span className={stage.state === 'done' ? 'gate ok' : 'gate'}>{stage.gate}</span>
              )}
            </span>
            <span className="sub">
              {stage.badge ? `${stage.badge} · ` : ''}
              {stage.note}
            </span>
          </button>
        ))}
      </div>
      {props.afterRail}
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
