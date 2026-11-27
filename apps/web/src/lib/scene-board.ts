import type {
  AssetDto,
  GenerationJobDto,
  StoryboardImagesDto,
  StoryboardVideosDto,
  StoryboardVoiceoversDto,
} from '@acf/contracts';

import { translator, type MessageKey, type Translate } from './i18n';
import { JOB_ERROR_GROUP_LABEL, jobError } from './job-errors';

/** What to do about a failed job, in a few words (the full text is in the job details). */
function failureHint(t: Translate, code: string | null): string {
  const group = code ? jobError(code).group : null;
  return group ? t(JOB_ERROR_GROUP_LABEL[group]) : t('cell.failed');
}

/**
 * The Scenes board (UX review U1, P3e): one row per scene with the state of its keyframe, clip
 * and voice-over, so a scene's progress is visible without switching tabs. Pure: built from the
 * three stage DTOs the content page already loads.
 */
export type Stage = 'keyframes' | 'clips' | 'voiceover';

export type CellState =
  | 'chosen' // a keyframe / clip / voice-over is selected
  | 'pick' // candidates exist, none selected yet
  | 'running' // a job is running
  | 'queued' // a job waits for a worker
  | 'failed' // the last job failed and nothing is selected
  | 'waiting' // blocked by an earlier stage
  | 'todo' // can be generated
  | 'none'; // not needed (no voice-over text)

export interface Cell {
  readonly stage: Stage;
  readonly state: CellState;
  readonly label: string;
  readonly sub: string;
  /** Chosen asset (thumbnail), when there is one. */
  readonly asset: AssetDto | null;
  readonly job: GenerationJobDto | null;
}

export type RowStatus = 'failed' | 'needs' | 'running' | 'done' | 'todo';

export interface SceneRow {
  readonly sceneId: string;
  readonly sceneNumber: number;
  readonly cells: readonly [Cell, Cell, Cell];
  readonly status: RowStatus;
  readonly statusLabel: string;
  /** When the earliest running job of the row started (elapsed time), if any. */
  readonly runningSince: string | null;
}

export const ROW_STATUS_LABEL: Readonly<Record<RowStatus, MessageKey>> = {
  failed: 'board.row.failed',
  needs: 'board.row.needs',
  running: 'board.row.running',
  done: 'board.row.done',
  todo: 'board.row.todo',
};

interface StageScene {
  readonly sceneId: string;
  readonly sceneNumber: number;
  readonly candidates: readonly AssetDto[];
  readonly activeJob: GenerationJobDto | null;
  readonly lastJob: GenerationJobDto | null;
}

function cell(
  t: Translate,
  stage: Stage,
  scene: StageScene | undefined,
  chosen: AssetDto | null,
  blocked: string | null,
  notNeeded = false,
): Cell {
  const job = scene?.activeJob ?? scene?.lastJob ?? null;
  const base = { stage, job, asset: chosen };
  if (notNeeded)
    return { ...base, state: 'none', label: t('cell.notNeeded'), sub: t('cell.noNarration') };
  if (scene?.activeJob?.status === 'running')
    return { ...base, state: 'running', label: t('cell.generating'), sub: t('cell.running') };
  if (scene?.activeJob?.status === 'queued')
    return { ...base, state: 'queued', label: t('cell.queued'), sub: t('cell.waitingWorker') };
  if (chosen) return { ...base, state: 'chosen', label: t('cell.chosen'), sub: chosen.label ?? '' };
  if (scene?.lastJob?.status === 'failed') {
    return {
      ...base,
      state: 'failed',
      label: scene.lastJob.finishable ? t('cell.checkFailed') : t('cell.failed'),
      sub: scene.lastJob.finishable
        ? t('cell.outputKept')
        : failureHint(t, scene.lastJob.errorCode),
    };
  }
  const pickable = (scene?.candidates ?? []).filter((a) => a.approvalStatus !== 'rejected');
  if (pickable.length > 0) {
    return {
      ...base,
      state: 'pick',
      label: t('cell.chooseOne'),
      sub: t('cell.candidates', { count: pickable.length }),
    };
  }
  if (blocked) return { ...base, state: 'waiting', label: t('cell.waiting'), sub: blocked };
  return { ...base, state: 'todo', label: t('cell.notGenerated'), sub: t('cell.ready') };
}

const offCell = (t: Translate): Cell => ({
  stage: 'voiceover',
  state: 'none',
  label: t('cell.off'),
  sub: t('cell.noVoiceover'),
  asset: null,
  job: null,
});

function rowStatus(cells: readonly Cell[]): RowStatus {
  if (cells.some((c) => c.state === 'failed')) return 'failed';
  if (cells.some((c) => c.state === 'pick')) return 'needs';
  if (cells.some((c) => c.state === 'running' || c.state === 'queued')) return 'running';
  if (cells.every((c) => c.state === 'chosen' || c.state === 'none')) return 'done';
  return 'todo';
}

const ORDER: Readonly<Record<RowStatus, number>> = {
  failed: 0,
  needs: 1,
  running: 2,
  todo: 3,
  done: 4,
};

/** Rows in scene order, with failed scenes first and finished ones last. */
export function buildSceneRows(
  images: StoryboardImagesDto | null,
  videos: StoryboardVideosDto | null,
  voiceovers: StoryboardVoiceoversDto | null,
  /** P4d: voice-over switched off for the item: the column reads "Off". */
  voiceEnabled = true,
  t: Translate = translator('en'),
): SceneRow[] {
  const ids = images?.scenes ?? videos?.scenes ?? voiceovers?.scenes ?? [];
  const rows = ids.map((s): SceneRow => {
    const img = images?.scenes.find((x) => x.sceneId === s.sceneId);
    const vid = videos?.scenes.find((x) => x.sceneId === s.sceneId);
    const voc = voiceovers?.scenes.find((x) => x.sceneId === s.sceneId);
    const keyframe = img?.keyframe ?? vid?.keyframe ?? null;
    const cells = [
      cell(t, 'keyframes', img, keyframe, null),
      cell(t, 'clips', vid, vid?.clip ?? null, keyframe ? null : t('cell.needsKeyframe')),
      voiceEnabled
        ? cell(
            t,
            'voiceover',
            voc,
            voc?.voiceover ?? null,
            null,
            voc !== undefined && voc.text === '',
          )
        : offCell(t),
    ] as const;
    const status = rowStatus(cells);
    const starts = cells
      .map((c) => (c.state === 'running' ? (c.job?.startedAt ?? null) : null))
      .filter((x): x is string => x !== null)
      .sort();
    return {
      sceneId: s.sceneId,
      sceneNumber: s.sceneNumber,
      cells,
      status,
      statusLabel: t(ROW_STATUS_LABEL[status]),
      runningSince: starts[0] ?? null,
    };
  });
  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.sceneNumber - b.sceneNumber);
}

export type BoardFilter = 'all' | 'needs' | 'running' | 'failed' | 'done';

export const FILTERS: readonly { readonly id: BoardFilter; readonly label: MessageKey }[] = [
  { id: 'all', label: 'board.filter.all' },
  { id: 'needs', label: 'board.filter.needs' },
  { id: 'running', label: 'board.filter.running' },
  { id: 'failed', label: 'board.filter.failed' },
  { id: 'done', label: 'board.filter.done' },
];

export function matchesFilter(row: SceneRow, filter: BoardFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs':
      return row.status === 'needs' || row.status === 'failed';
    case 'running':
      return row.status === 'running';
    case 'failed':
      return row.status === 'failed';
    case 'done':
      return row.status === 'done';
  }
}

/** "0:45", "12:03", "1:02:09" since `iso` at `now` (ms). */
export function elapsed(iso: string, now: number): string {
  const total = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

export interface NextStep {
  readonly title: string;
  readonly detail: string;
  /** Workspace tab to open, plus the Scenes board filter when it is the Scenes tab. */
  readonly tab: string;
  readonly filter?: BoardFilter;
  readonly action: string;
}

/**
 * The one thing to do next (UX review U2), from the checklist the page already computes and the
 * scene rows. Null when everything is done.
 */
export function nextStep(
  checklist: readonly { readonly label: string; readonly done: boolean; readonly note: string }[],
  rows: readonly SceneRow[],
  t: Translate = translator('en'),
): NextStep | null {
  const failed = rows.filter((r) => r.status === 'failed').length;
  const needs = rows.filter((r) => r.status === 'needs').length;
  const running = rows.filter((r) => r.status === 'running').length;
  const runningNote = running > 0 ? t('next.stillGenerating', { count: running }) : '';
  const first = checklist.find((c) => !c.done);
  if (!first) return null;
  const scenesStep = ['Keyframe selection', 'Clip selection', 'Voice-over selection'].includes(
    first.label,
  );
  if (scenesStep && failed > 0) {
    return {
      title: t('next.fix', { count: failed }),
      detail: runningNote || t('next.fixDetail'),
      tab: 'scenes',
      filter: 'failed',
      action: t('next.showFailed'),
    };
  }
  if (scenesStep && needs > 0) {
    return {
      title: t('next.choose', { count: needs }),
      detail: runningNote || t('next.chooseDetail'),
      tab: 'scenes',
      filter: 'needs',
      action: t('next.showNeeds'),
    };
  }
  if (scenesStep && running > 0) {
    return {
      title: t('next.generating'),
      detail: `${runningNote} ${t('next.nothingNeeded')}`,
      tab: 'scenes',
      filter: 'running',
      action: t('next.showRunning'),
    };
  }
  const map: Readonly<Record<string, Omit<NextStep, 'detail'>>> = {
    'Script generated': {
      title: t('next.generateScript'),
      tab: 'script',
      action: t('next.openScript'),
    },
    'Script approval': {
      title: t('next.reviewScript'),
      tab: 'script',
      action: t('next.openScript'),
    },
    'Storyboard approval': {
      title: t('next.reviewStoryboard'),
      tab: 'storyboard',
      action: t('next.openStoryboard'),
    },
    'Keyframe selection': {
      title: t('next.generateKeyframes'),
      tab: 'scenes',
      action: t('next.openScenes'),
    },
    'Clip selection': {
      title: t('next.generateClips'),
      tab: 'scenes',
      action: t('next.openScenes'),
    },
    'Voice-over selection': {
      title: t('next.generateVoice'),
      tab: 'scenes',
      action: t('next.openScenes'),
    },
    'Render & export': {
      title: t('next.render'),
      tab: 'render',
      action: t('next.openRender'),
    },
  };
  const step = map[first.label] ?? { title: first.label, tab: 'script', action: t('next.open') };
  return { ...step, detail: first.note };
}
