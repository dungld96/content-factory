// Live job tracking and the cost-confirmation threshold (redesign R-D4, R-D5): the active-jobs
// snapshot, the polling fallback with ETag/304, the event stream (with resume by cursor), the
// project filter, and the workspace and project thresholds.
import { randomUUID } from 'node:crypto';
import http from 'node:http';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActiveJobsDto, BudgetDto, JobChangesDto, SpendingSettingsDto } from '@acf/contracts';

import { seedAiRegistry } from '../../src/cli/seed-ai.js';
import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import {
  actAs,
  addGenerationFixture,
  createFixture,
  emailOf,
  seedUsers,
  signInAll,
  type Fixture,
  type GenerationFixture,
  type Persona,
  type Session,
} from '../support/workspace.js';

let db: pg.Client;
let ids: Record<string, string>;
let api: AuthTestApp;
let sessions: Record<Persona, Session>;
let as: ReturnType<typeof actAs>;
let w: Fixture & GenerationFixture;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
const bodyOf = <T>(res: { json: unknown }) => res.json as T;

/** A queued render job of the fixture plus its first job event. */
async function queuedJob(): Promise<string> {
  const id = randomUUID();
  // One active render per content item (active_key): finish the previous one first.
  await db.query(
    `UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now()
      WHERE content_item_id = $1 AND status IN ('queued', 'running')`,
    [w.contentId],
  );
  await db.query(`INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind,
      status, attempt, active_key, idempotency_key, execution_key, input, previous_content_status,
      prompt_template_id, model_id, requested_by_id, updated_at)
    SELECT '${id}', '${w.projectId}', '${w.contentId}', '${w.runId}', 'render', 'queued', 0,
      '${w.contentId}:render', 'live-${id}', repeat('e', 64), '{}', 'draft', 'x.v1', m.id, '${ids['owner'] ?? ''}', now()
    FROM ai_models m WHERE m.model_key = 'mock/echo'`);
  await event(id, null, 'queued');
  return id;
}

async function event(jobId: string, from: string | null, to: string): Promise<void> {
  await db.query(
    `INSERT INTO job_events (id, project_id, job_id, from_status, to_status, attempt, detail)
     VALUES ($1, $2, $3, $4, $5, 1, '{}')`,
    [randomUUID(), w.projectId, jobId, from, to],
  );
}

/** Opens the event stream as `who` and collects `event: job` payloads until `count` arrive. */
function stream(
  who: Persona,
  query: string,
  count: number,
  timeoutMs = 6_000,
): Promise<{ events: { jobId: string; to: string; id: string }[]; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v1/events${query}`, api.baseUrl);
    const raw: string[] = [];
    const events: { jobId: string; to: string; id: string }[] = [];
    const req = http.get(
      url,
      { headers: { cookie: sessions[who].jar.header(), accept: 'text/event-stream' } },
      (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.headers['x-accel-buffering']).toBe('no');
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw.push(chunk);
          for (const block of chunk.split('\n\n')) {
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (/^event: job$/m.test(block) && data) events.push(JSON.parse(data) as never);
          }
          if (events.length >= count) {
            req.destroy();
            resolve({ events, raw: raw.join('') });
          }
        });
      },
    );
    req.on('error', (e) => {
      if (events.length < count) reject(e);
    });
    setTimeout(() => {
      req.destroy();
      resolve({ events, raw: raw.join('') });
    }, timeoutMs);
  });
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  ids = await seedUsers(admin.users);
  await seedAiRegistry(admin.prisma, { openrouterConfigured: false });
  api = await startAuthApp({ OPERATOR_EMAILS: emailOf('owner') });
  sessions = await signInAll(api.baseUrl, ids);
  as = actAs(api.baseUrl, sessions);
  const base = await createFixture(db, ids);
  w = { ...base, ...(await addGenerationFixture(db, ids, base)) };
});

afterAll(async () => {
  await api.close();
  await db.end();
});

describe('live jobs (R-D5)', () => {
  it('lists active jobs of the caller’s projects only', async () => {
    const jobId = await queuedJob();
    const mine = bodyOf<ActiveJobsDto>(await as('viewer', 'GET', '/jobs/active'));
    expect(mine.jobs.map((j) => j.jobId)).toContain(jobId);
    expect(mine.cursor).toMatch(/^\d{13}-/);
    const outsider = bodyOf<ActiveJobsDto>(await as('outsider', 'GET', '/jobs/active'));
    expect(outsider.jobs).toEqual([]);
  });

  it('returns changes after a cursor, with an ETag and 304 when nothing is new', async () => {
    const { cursor } = bodyOf<ActiveJobsDto>(await as('editor', 'GET', '/jobs/active'));
    const jobId = await queuedJob();
    await event(jobId, 'queued', 'running');
    const res = await as('editor', 'GET', `/jobs/changes?since=${cursor}`);
    expect(res.status).toBe(200);
    const body = bodyOf<JobChangesDto>(res);
    expect(body.resync).toBe(false);
    expect(body.events.filter((e) => e.jobId === jobId).map((e) => e.to)).toEqual([
      'queued',
      'running',
    ]);
    expect(body.events[0]?.contentTitle).toBeTruthy();
    const etag = res.headers.get('etag') ?? '';
    const again = await as('editor', 'GET', `/jobs/changes?since=${cursor}`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    const hidden = bodyOf<JobChangesDto>(
      await as('outsider', 'GET', `/jobs/changes?since=${cursor}`),
    );
    expect(hidden.events).toEqual([]);
  });

  it('asks for a resync when the cursor is too old, and refuses a malformed one', async () => {
    const old = `${String(Date.now() - 60 * 60_000).padStart(13, '0')}-00000000-0000-0000-0000-000000000000`;
    expect(
      bodyOf<JobChangesDto>(await as('editor', 'GET', `/jobs/changes?since=${old}`)).resync,
    ).toBe(true);
    expect((await as('editor', 'GET', '/jobs/changes?since=nope')).status).toBe(400);
  });

  it('streams new events and resumes from a cursor', async () => {
    const { cursor } = bodyOf<ActiveJobsDto>(await as('editor', 'GET', '/jobs/active'));
    const jobId = await queuedJob();
    // Resume: the event written before connecting arrives from the backlog.
    const backlog = await stream('editor', `?since=${cursor}`, 50, 1_500);
    expect(backlog.raw).toContain('retry: 5000');
    expect(backlog.events.some((e) => e.jobId === jobId)).toBe(true);
    // Live: an event written after connecting arrives through the shared tailer.
    const live = stream('viewer', '', 1);
    await new Promise((r) => setTimeout(r, 300));
    await event(jobId, 'queued', 'running');
    const got = await live;
    expect(got.events.map((e) => [e.jobId, e.to])).toContainEqual([jobId, 'running']);
  });

  it('follows a project the user joins after the stream opened', async () => {
    const live = stream('editor', '', 1, 5_000);
    await new Promise((r) => setTimeout(r, 300));
    const before = w;
    const base = await createFixture(db, ids);
    w = { ...base, ...(await addGenerationFixture(db, ids, base)) };
    const jobId = await queuedJob();
    const got = await live;
    w = before;
    expect(got.events.map((e) => e.jobId)).toContain(jobId);
  });

  it('sends nothing of other projects', async () => {
    const live = stream('outsider', '', 1, 2_500);
    await new Promise((r) => setTimeout(r, 300));
    await queuedJob();
    expect((await live).events).toEqual([]);
  });
});

describe('cost-confirmation threshold (R-D4)', () => {
  it('defaults to $1 and only operators change it, within 0–1000 with two decimals', async () => {
    expect(bodyOf<SpendingSettingsDto>(await as('viewer', 'GET', '/settings/spending'))).toEqual({
      confirmThresholdUsd: '1',
      updatedAt: null,
    });
    expect(
      (await as('editor', 'PUT', '/settings/spending', { body: { confirmThresholdUsd: '2' } }))
        .status,
    ).toBe(403);
    for (const bad of ['1001', '0.001', '-1', 'abc']) {
      const res = await as('owner', 'PUT', '/settings/spending', {
        body: { confirmThresholdUsd: bad },
      });
      expect(res.status, bad).toBe(400);
    }
    const saved = await as('owner', 'PUT', '/settings/spending', {
      body: { confirmThresholdUsd: '2.5' },
    });
    expect(saved.status).toBe(200);
    expect(bodyOf<SpendingSettingsDto>(saved).confirmThresholdUsd).toBe('2.5');
  });

  it('applies a project override and falls back to the workspace when it is cleared', async () => {
    const path = `/projects/${w.projectId}/budget`;
    const before = bodyOf<BudgetDto>(await as('viewer', 'GET', path));
    expect(before.confirmThresholdUsd).toBeNull();
    expect(before.effectiveConfirmThresholdUsd).toBe('2.5');
    const set = await as('owner', 'PUT', path, { body: { confirmThresholdUsd: '0.5' } });
    expect(set.status).toBe(200);
    expect(bodyOf<BudgetDto>(set).effectiveConfirmThresholdUsd).toBe('0.5');
    expect((await as('editor', 'PUT', path, { body: { confirmThresholdUsd: '9' } })).status).toBe(
      403,
    );
    const cleared = await as('owner', 'PUT', path, { body: { confirmThresholdUsd: null } });
    expect(bodyOf<BudgetDto>(cleared).effectiveConfirmThresholdUsd).toBe('2.5');
  });
});
