import { describe, expect, it } from 'vitest';

import type {
  AssetDto,
  GenerationJobDto,
  StoryboardImagesDto,
  StoryboardVideosDto,
  StoryboardVoiceoversDto,
} from '@acf/contracts';

import { buildSceneRows, elapsed, matchesFilter, nextStep } from './scene-board';

const asset = (id: string, approvalStatus: AssetDto['approvalStatus'] = 'approved') =>
  ({ id, approvalStatus, label: `asset ${id}` }) as AssetDto;
const job = (over: Partial<GenerationJobDto>) =>
  ({
    status: 'succeeded',
    startedAt: '2026-11-21T10:00:00.000Z',
    errorCode: null,
    finishable: false,
    ...over,
  }) as GenerationJobDto;

const S = ['s1', 's2', 's3', 's4'];

function fixture() {
  const images = {
    storyboardVersionId: 'b',
    scenes: [
      {
        sceneId: 's1',
        sceneNumber: 1,
        keyframe: asset('k1'),
        candidates: [asset('k1')],
        activeJob: null,
        lastJob: job({}),
      },
      {
        sceneId: 's2',
        sceneNumber: 2,
        keyframe: asset('k2'),
        candidates: [asset('k2')],
        activeJob: null,
        lastJob: job({}),
      },
      {
        sceneId: 's3',
        sceneNumber: 3,
        keyframe: null,
        candidates: [asset('c3'), asset('c3b', 'rejected')],
        activeJob: null,
        lastJob: job({}),
      },
      {
        sceneId: 's4',
        sceneNumber: 4,
        keyframe: null,
        candidates: [],
        activeJob: job({ status: 'running' }),
        lastJob: null,
      },
    ],
  } as unknown as StoryboardImagesDto;
  const videos = {
    scenes: [
      {
        sceneId: 's1',
        sceneNumber: 1,
        keyframe: asset('k1'),
        clip: asset('v1'),
        candidates: [],
        activeJob: null,
        lastJob: job({}),
      },
      {
        sceneId: 's2',
        sceneNumber: 2,
        keyframe: asset('k2'),
        clip: null,
        candidates: [],
        activeJob: null,
        lastJob: job({ status: 'failed', errorCode: 'MEDIA_TOOLS_MISSING', finishable: true }),
      },
      {
        sceneId: 's3',
        sceneNumber: 3,
        keyframe: null,
        clip: null,
        candidates: [],
        activeJob: null,
        lastJob: null,
      },
      {
        sceneId: 's4',
        sceneNumber: 4,
        keyframe: null,
        clip: null,
        candidates: [],
        activeJob: null,
        lastJob: null,
      },
    ],
  } as unknown as StoryboardVideosDto;
  const voiceovers = {
    scenes: S.map((id, i) => ({
      sceneId: id,
      sceneNumber: i + 1,
      text: id === 's4' ? '' : 'Hello',
      voiceover: id === 's1' ? asset('a1') : null,
      candidates: [],
      activeJob: null,
      lastJob: null,
    })),
  } as unknown as StoryboardVoiceoversDto;
  return { images, videos, voiceovers };
}

describe('Scenes board (UX review U1)', () => {
  it('derives each stage state and sorts failed scenes first, done last', () => {
    const f = fixture();
    const rows = buildSceneRows(f.images, f.videos, f.voiceovers);
    expect(rows.map((r) => [r.sceneNumber, r.status])).toEqual([
      [2, 'failed'],
      [3, 'needs'],
      [4, 'running'],
      [1, 'done'],
    ]);
    const s2 = rows[0];
    expect(s2?.cells.map((c) => c.state)).toEqual(['chosen', 'failed', 'todo']);
    expect(s2?.cells[1].label).toBe('Check failed');
    const s3 = rows[1];
    // A rejected candidate does not count; the clip waits for a keyframe.
    expect(s3?.cells.map((c) => [c.state, c.sub])).toEqual([
      ['pick', '1 candidate'],
      ['waiting', 'Needs a keyframe'],
      ['todo', 'Ready to generate'],
    ]);
    // No narration text: the voice-over is not needed.
    expect(rows[2]?.cells[2].state).toBe('none');
    expect(rows[2]?.runningSince).toBe('2026-11-21T10:00:00.000Z');
  });

  it('filters rows', () => {
    const f = fixture();
    const rows = buildSceneRows(f.images, f.videos, f.voiceovers);
    const count = (filter: Parameters<typeof matchesFilter>[1]) =>
      rows.filter((r) => matchesFilter(r, filter)).length;
    expect([
      count('all'),
      count('needs'),
      count('running'),
      count('failed'),
      count('done'),
    ]).toEqual([4, 2, 1, 1, 1]);
  });

  it('formats elapsed time', () => {
    const start = '2026-11-21T10:00:00.000Z';
    const t0 = Date.parse(start);
    expect(elapsed(start, t0 + 45_000)).toBe('0:45');
    expect(elapsed(start, t0 + 723_000)).toBe('12:03');
    expect(elapsed(start, t0 + 3_729_000)).toBe('1:02:09');
  });

  it('points the Next step at failed scenes first, then the gate in progress', () => {
    const f = fixture();
    const rows = buildSceneRows(f.images, f.videos, f.voiceovers);
    const checklist = [
      { label: 'Script approval', done: true, note: '' },
      { label: 'Keyframe selection', done: false, note: '2 of 4' },
    ];
    expect(nextStep(checklist, rows)).toMatchObject({
      title: 'Fix 1 scene',
      tab: 'scenes',
      filter: 'failed',
    });
    expect(
      nextStep([{ label: 'Script approval', done: false, note: 'Waiting' }], rows),
    ).toMatchObject({ title: 'Review the script', tab: 'script' });
    expect(nextStep([{ label: 'Render & export', done: true, note: '' }], rows)).toBeNull();
  });

  it('shows the voice-over column as Off when the item has no voice-over (P4d)', () => {
    const f = fixture();
    const rows = buildSceneRows(f.images, f.videos, f.voiceovers, false);
    expect(rows.every((r) => r.cells[2].state === 'none' && r.cells[2].label === 'Off')).toBe(true);
    // Scene 1 has a keyframe and a clip: done without a voice-over.
    expect(rows.find((r) => r.sceneNumber === 1)?.status).toBe('done');
  });
});
