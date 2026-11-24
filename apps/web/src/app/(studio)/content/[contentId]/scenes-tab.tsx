'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

import type {
  StoryboardImagesDto,
  StoryboardVideosDto,
  StoryboardVoiceoversDto,
  VoiceProfileDto,
} from '@acf/contracts';

import { useT } from '@/components/i18n-provider';
import { Icon } from '@/components/icon';
import type { ModelOption } from '@/components/model-select';
import { assetContentUrl } from '@/lib/asset-url';
import type { MessageKey } from '@/lib/i18n';
import {
  buildSceneRows,
  elapsed,
  FILTERS,
  matchesFilter,
  type BoardFilter,
  type Cell,
  type SceneRow,
  type Stage,
} from '@/lib/scene-board';

import { SceneClipsPanel } from './scene-clips';
import { SceneImagesPanel } from './scene-images';
import { SceneVoiceoversPanel } from './scene-voiceovers';

const STAGES: readonly { readonly id: Stage; readonly label: MessageKey }[] = [
  { id: 'keyframes', label: 'st.keyframes' },
  { id: 'clips', label: 'st.clips' },
  { id: 'voiceover', label: 'st.voiceover' },
];

const STAGE_TITLE: Readonly<Record<Stage, MessageKey>> = {
  keyframes: 'st.keyframe',
  clips: 'st.clip',
  voiceover: 'st.voiceover',
};

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT');

/** A clock ticking every second while something runs (elapsed times). */
let tick = 0;
const tickers = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | undefined;
function subscribeTick(listener: () => void): () => void {
  if (tickers.size === 0) {
    tick = Date.now();
    tickTimer = setInterval(() => {
      tick = Date.now();
      for (const l of tickers) l();
    }, 1000);
  }
  tickers.add(listener);
  return () => {
    tickers.delete(listener);
    if (tickers.size === 0) clearInterval(tickTimer);
  };
}
function useTick(): number | null {
  return useSyncExternalStore(
    subscribeTick,
    () => tick || null,
    () => null,
  );
}

/** `#scenes?filter=failed&stage=clips` → its parts (the Next step card links this way). */
function readHash(): { stage: Stage | null; filter: BoardFilter | null } {
  const [id, query] = window.location.hash.slice(1).split('?');
  const params = new URLSearchParams(query ?? '');
  const stage = (['keyframes', 'clips', 'voiceover'] as const).find(
    (s) => s === id || s === params.get('stage'),
  );
  const filter = FILTERS.find((f) => f.id === params.get('filter'))?.id ?? null;
  return { stage: stage ?? null, filter };
}

/**
 * The Scenes tab (UX review U1, P3e): a compact board with one row per scene and the state of
 * its keyframe, clip and voice-over; filters with counts, failed scenes first, elapsed time of
 * running jobs. Choosing a cell opens that stage's panel for that scene only (the existing
 * generate / review / choose controls); "All scenes" shows every scene again.
 */
export function ScenesTab(props: {
  readonly contentId: string;
  readonly canEdit: boolean;
  readonly images: StoryboardImagesDto | null;
  readonly videos: StoryboardVideosDto | null;
  readonly voiceovers: StoryboardVoiceoversDto | null;
  /** No approved storyboard yet (gate 2). */
  readonly locked: boolean;
  readonly loadFailed: boolean;
  readonly generating: boolean;
  readonly imageModels: readonly ModelOption[];
  readonly videoModels: readonly ModelOption[];
  readonly profiles: readonly VoiceProfileDto[];
  readonly initialStage: Stage;
  /** P4d: voice-over on for the item (off hides the voice-over stage). */
  readonly voiceEnabled: boolean;
  /** R-D4: paid generations above this total (USD) or with an unknown price ask first. */
  readonly confirmThresholdUsd: string;
}) {
  const t = useT();
  const tableRef = useRef<HTMLDivElement>(null);
  const [chosenStage, setStage] = useState<Stage>(props.initialStage);
  const stage: Stage = !props.voiceEnabled && chosenStage === 'voiceover' ? 'clips' : chosenStage;
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [focus, setFocus] = useState<string | null>(null);
  const rows = useMemo(
    () => buildSceneRows(props.images, props.videos, props.voiceovers, props.voiceEnabled, t),
    [props.images, props.videos, props.voiceovers, props.voiceEnabled, t],
  );
  const now = useTick();

  useEffect(() => {
    const apply = () => {
      const h = readHash();
      if (h.stage) setStage(h.stage);
      if (h.filter) {
        setFilter(h.filter);
        setFocus(null);
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => {
      window.removeEventListener('hashchange', apply);
    };
  }, []);

  if (props.locked) {
    return (
      <section className="card work-card">
        <div className="section-head">
          <div>
            <h2>{t('st.title')}</h2>
            <p>{t('st.lockedHint')}</p>
          </div>
        </div>
        <div className="empty">{t('st.locked')}</div>
      </section>
    );
  }
  if (props.loadFailed) {
    return (
      <p className="notice error" role="alert">
        {t('st.loadError')}
      </p>
    );
  }

  const visible = rows.filter((r) => matchesFilter(r, filter));
  const count = (f: BoardFilter) => rows.filter((r) => matchesFilter(r, f)).length;
  const done = rows.filter((r) => r.status === 'done').length;
  const focusRow = rows.find((r) => r.sceneId === focus) ?? null;

  function open(row: SceneRow, cell: Cell) {
    setStage(cell.stage);
    setFocus(row.sceneId);
    window.history.replaceState(null, '', `#${cell.stage}`);
    requestAnimationFrame(() => {
      document.getElementById('scene-stage-panel')?.scrollIntoView({ block: 'start' });
    });
  }

  /** Gate 3 review keys (R4): J / K move between scene rows, Enter opens the focused cell. */
  function onBoardKey(event: KeyboardEvent<HTMLDivElement>) {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'j' && key !== 'k') return;
    event.preventDefault();
    const rowsEls = [...(tableRef.current?.querySelectorAll<HTMLElement>('.board-row') ?? [])];
    const current = rowsEls.findIndex((r) => r.contains(document.activeElement));
    const next =
      rowsEls[Math.max(0, Math.min(rowsEls.length - 1, current + (key === 'j' ? 1 : -1)))];
    const target =
      next?.querySelector<HTMLButtonElement>('.board-cell:not(.chosen):not(.none)') ??
      next?.querySelector<HTMLButtonElement>('.board-cell');
    target?.focus();
  }

  function chooseStage(next: Stage) {
    setStage(next);
    window.history.replaceState(null, '', `#${next}`);
  }

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    const i = STAGES.findIndex((s) => s.id === stage);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = STAGES[(i + step + STAGES.length) % STAGES.length];
    if (next) {
      chooseStage(next.id);
      document.getElementById(`stage-${next.id}`)?.focus();
    }
  }

  const badge: Readonly<Record<Stage, string>> = {
    keyframes: `${String(rows.filter((r) => r.cells[0].state === 'chosen').length)}/${String(rows.length)}`,
    clips: `${String(rows.filter((r) => r.cells[1].state === 'chosen').length)}/${String(rows.length)}`,
    voiceover: `${String(rows.filter((r) => r.cells[2].state === 'chosen').length)}/${String(
      rows.filter((r) => r.cells[2].state !== 'none').length,
    )}`,
  };

  return (
    <>
      <section className="card work-card scene-board" aria-label={t('st.board')}>
        <div className="section-head">
          <div>
            <h2>{t('st.title')}</h2>
            <p>{t('st.done', { done, total: rows.length })}</p>
            <p className="muted small-text">{t('st.keysHint')}</p>
          </div>
          {props.generating && (
            <span className="status purple" role="status">
              {t('st.generating')}
            </span>
          )}
        </div>
        <div className="board-filters" role="group" aria-label={t('st.filter')}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? 'chip active' : 'chip'}
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
              }}
            >
              {t(f.label)} <span className="chip-num">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <div
          className="board-table"
          role="table"
          aria-label={t('st.table')}
          ref={tableRef}
          onKeyDown={onBoardKey}
        >
          <div className="board-head" role="row">
            <span role="columnheader">{t('st.colScene')}</span>
            <span role="columnheader">{t('st.keyframe')}</span>
            <span role="columnheader">{t('st.clip')}</span>
            <span role="columnheader">{t('st.voiceover')}</span>
            <span role="columnheader">{t('st.colStatus')}</span>
          </div>
          {visible.length === 0 ? (
            <p className="muted board-empty">{t('st.noRows')}</p>
          ) : (
            visible.map((row) => (
              <div
                key={row.sceneId}
                role="row"
                className={row.sceneId === focus ? 'board-row focused' : 'board-row'}
                aria-label={t('st.rowLabel', { number: row.sceneNumber, status: row.statusLabel })}
              >
                <span role="rowheader" className="board-scene">
                  <b>{String(row.sceneNumber).padStart(2, '0')}</b>
                </span>
                {row.cells.map((c) => (
                  <span role="cell" key={c.stage}>
                    <button
                      type="button"
                      className={`board-cell ${c.state}`}
                      onClick={() => {
                        open(row, c);
                      }}
                      aria-label={`${t('st.cellLabel', {
                        number: row.sceneNumber,
                        stage: t(STAGE_TITLE[c.stage]),
                        label: c.label,
                      })}${c.sub ? `, ${c.sub}` : ''}`}
                    >
                      <CellThumb cell={c} />
                      <span className="board-cell-copy">
                        <b>{c.label}</b>
                        <small>
                          {c.state === 'running' && c.job?.startedAt && now !== null
                            ? t('st.elapsed', { time: elapsed(c.job.startedAt, now) })
                            : c.sub}
                        </small>
                      </span>
                    </button>
                  </span>
                ))}
                <span role="cell" className="board-status">
                  <span className={`status ${STATUS_TONE[row.status]}`}>{row.statusLabel}</span>
                  {row.runningSince && now !== null && (
                    <small className="muted">{elapsed(row.runningSince, now)}</small>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card work-card" id="scene-stage-panel" aria-label={t('st.stagePanel')}>
        <div
          className="tabs stage-tabs"
          role="tablist"
          aria-label={t('st.stagePanel')}
          onKeyDown={onStageKey}
        >
          {STAGES.filter((s) => props.voiceEnabled || s.id !== 'voiceover').map((s) => (
            <button
              key={s.id}
              id={`stage-${s.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={stage === s.id}
              aria-controls={`stage-panel-${s.id}`}
              tabIndex={stage === s.id ? 0 : -1}
              onClick={() => {
                chooseStage(s.id);
              }}
            >
              {t(s.label)}
              <span className="chip-count">{badge[s.id]}</span>
            </button>
          ))}
        </div>
        {focusRow && (
          <p className="focus-note" role="status">
            {t('st.onlyScene', { number: focusRow.sceneNumber })}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setFocus(null);
              }}
            >
              {t('st.showAll')}
            </button>
          </p>
        )}
        <div
          id="stage-panel-keyframes"
          role="tabpanel"
          aria-labelledby="stage-keyframes"
          hidden={stage !== 'keyframes'}
        >
          {props.images && (
            <SceneImagesPanel
              images={props.images}
              canEdit={props.canEdit}
              models={props.imageModels}
              onlySceneId={focus}
              confirmThresholdUsd={props.confirmThresholdUsd}
            />
          )}
        </div>
        <div
          id="stage-panel-clips"
          role="tabpanel"
          aria-labelledby="stage-clips"
          hidden={stage !== 'clips'}
        >
          {props.videos && (
            <SceneClipsPanel
              videos={props.videos}
              canEdit={props.canEdit}
              models={props.videoModels}
              onlySceneId={focus}
              confirmThresholdUsd={props.confirmThresholdUsd}
            />
          )}
        </div>
        <div
          id="stage-panel-voiceover"
          role="tabpanel"
          aria-labelledby="stage-voiceover"
          hidden={stage !== 'voiceover'}
        >
          {props.voiceovers && props.voiceEnabled && (
            <SceneVoiceoversPanel
              contentId={props.contentId}
              voiceovers={props.voiceovers}
              profiles={props.profiles}
              canEdit={props.canEdit}
              onlySceneId={focus}
              confirmThresholdUsd={props.confirmThresholdUsd}
            />
          )}
        </div>
      </section>
    </>
  );
}

const STATUS_TONE = {
  failed: 'red',
  needs: 'amber',
  running: 'purple',
  done: 'green',
  todo: 'gray',
} as const;

function CellThumb({ cell }: { readonly cell: Cell }) {
  if (cell.asset && cell.stage === 'keyframes') {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- authenticated API media
      <img className="board-thumb" src={assetContentUrl(cell.asset.id)} alt="" loading="lazy" />
    );
  }
  const icon =
    cell.state === 'chosen'
      ? cell.stage === 'voiceover'
        ? 'music'
        : cell.stage === 'clips'
          ? 'play'
          : 'image'
      : cell.state === 'failed'
        ? 'warning'
        : cell.state === 'running' || cell.state === 'queued'
          ? 'history'
          : cell.state === 'pick'
            ? 'check'
            : cell.state === 'none'
              ? 'cancel'
              : 'generate';
  return (
    <span className={`board-thumb ${cell.state}`} aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  );
}
