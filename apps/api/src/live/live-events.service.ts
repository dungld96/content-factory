import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import type { ActiveJobsDto, JobChangesDto, LiveJobEventDto } from '@acf/contracts';

import { PrismaService } from '../infrastructure/prisma.service.js';
import { cursorOf, cursorTime, nowCursor, OVERLAP_MS } from './live-cursor.js';

/** How often the shared tailer reads new job events while someone listens. */
export const TAIL_INTERVAL_MS = 1_000;
/** A resume further back than this, or with more events, asks the client to reload. */
export const MAX_BACKLOG_EVENTS = 1_000;
export const MAX_BACKLOG_MS = 15 * 60_000;

interface EventRow {
  readonly id: string;
  readonly created_at: Date;
  readonly from_status: LiveJobEventDto['from'];
  readonly to_status: LiveJobEventDto['to'];
  readonly attempt: number;
  readonly job_id: string;
  readonly project_id: string;
  readonly content_item_id: string;
  readonly production_run_id: string;
  readonly kind: LiveJobEventDto['kind'];
  readonly scene_number: number | null;
  readonly title: string;
}

export interface LiveSubscriber {
  readonly projectIds: ReadonlySet<string>;
  readonly send: (event: LiveJobEventDto) => void;
}

interface Listener extends LiveSubscriber {
  /** Rows created before this were the stream's backlog, not live news. */
  readonly joinedAt: number;
}

const toEvent = (r: EventRow): LiveJobEventDto => ({
  id: cursorOf(r.created_at, r.id),
  jobId: r.job_id,
  projectId: r.project_id,
  contentItemId: r.content_item_id,
  contentTitle: r.title,
  productionRunId: r.production_run_id,
  kind: r.kind,
  sceneNumber: r.scene_number,
  from: r.from_status,
  to: r.to_status,
  attempt: r.attempt,
  at: r.created_at.toISOString(),
});

/**
 * Live job deltas (redesign R-D5, package §5). One tailer per API process reads `job_events`
 * once a second while at least one stream is open and fans the rows out in memory, so the
 * database cost does not grow with the number of browsers. PostgreSQL stays the source of
 * truth: rows are read after commit, and nothing is lost when Redis is down.
 */
@Injectable()
export class LiveEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveEventsService.name);
  private readonly subscribers = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private since = new Date();
  /** Event ids already sent, with their time, to skip the overlap re-read. */
  private readonly seen = new Map<string, number>();
  private ticking = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy(): void {
    this.stop();
  }

  get listeners(): number {
    return this.subscribers.size;
  }

  /** Projects whose jobs the user may follow (every membership). */
  async projectsOf(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.client.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return new Set(rows.map((r) => r.projectId));
  }

  subscribe(subscriber: LiveSubscriber): () => void {
    const listener: Listener = { ...subscriber, joinedAt: Date.now() };
    this.subscribers.add(listener);
    if (!this.timer) {
      this.since = new Date();
      this.seen.clear();
      this.timer = setInterval(() => void this.tick(), TAIL_INTERVAL_MS);
      this.timer.unref();
    }
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** The caller's queued and running jobs, and the cursor to follow changes from. */
  async active(projectIds: ReadonlySet<string>): Promise<ActiveJobsDto> {
    const cursor = nowCursor();
    if (projectIds.size === 0) return { cursor, jobs: [] };
    const jobs = await this.prisma.client.generationJob.findMany({
      where: { projectId: { in: [...projectIds] }, status: { in: ['queued', 'running'] } },
      select: {
        id: true,
        projectId: true,
        contentItemId: true,
        kind: true,
        status: true,
        attempt: true,
        updatedAt: true,
        storyboardSceneId: true,
        contentItem: { select: { title: true } },
      },
      orderBy: { queuedAt: 'asc' },
      take: 200,
    });
    const sceneIds = jobs.flatMap((j) => (j.storyboardSceneId ? [j.storyboardSceneId] : []));
    const scenes = sceneIds.length
      ? await this.prisma.client.storyboardScene.findMany({
          where: { id: { in: sceneIds } },
          select: { id: true, sceneNumber: true },
        })
      : [];
    const number = new Map(scenes.map((s) => [s.id, s.sceneNumber]));
    return {
      cursor,
      jobs: jobs.map((j) => ({
        jobId: j.id,
        projectId: j.projectId,
        contentItemId: j.contentItemId,
        contentTitle: j.contentItem.title,
        kind: j.kind,
        sceneNumber: j.storyboardSceneId ? (number.get(j.storyboardSceneId) ?? null) : null,
        status: j.status === 'running' ? 'running' : 'queued',
        attempt: j.attempt,
        updatedAt: j.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Events after `cursor` (with the overlap window; clients de-duplicate by id). `resync` when
   * the cursor is too old or the backlog too long.
   */
  async changes(cursor: string, projectIds: ReadonlySet<string>): Promise<JobChangesDto> {
    const time = cursorTime(cursor);
    const now = new Date();
    if (!time || now.getTime() - time.getTime() > MAX_BACKLOG_MS) {
      return { cursor: nowCursor(now), events: [], resync: true };
    }
    const rows = await this.read(new Date(time.getTime() - OVERLAP_MS), MAX_BACKLOG_EVENTS + 1);
    const mine = rows.filter((r) => projectIds.has(r.project_id));
    if (rows.length > MAX_BACKLOG_EVENTS) {
      return { cursor: nowCursor(now), events: [], resync: true };
    }
    const last = rows.at(-1);
    const lastCursor = last ? cursorOf(last.created_at, last.id) : cursor;
    return {
      cursor: lastCursor > cursor ? lastCursor : cursor,
      events: mine.map(toEvent),
      resync: false,
    };
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const from = new Date(this.since.getTime() - OVERLAP_MS);
      const rows = await this.read(from, 500);
      for (const row of rows) {
        if (this.seen.has(row.id)) continue;
        this.seen.set(row.id, row.created_at.getTime());
        if (row.created_at > this.since) this.since = row.created_at;
        const event = toEvent(row);
        for (const s of this.subscribers) {
          if (s.projectIds.has(row.project_id) && row.created_at.getTime() >= s.joinedAt) {
            s.send(event);
          }
        }
      }
      const keepAfter = this.since.getTime() - 2 * OVERLAP_MS;
      for (const [id, ms] of this.seen) if (ms < keepAfter) this.seen.delete(id);
    } catch (error) {
      this.logger.warn({ msg: 'live_tail_failed', error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private read(from: Date, limit: number): Promise<EventRow[]> {
    return this.prisma.client.$queryRaw<EventRow[]>`
      SELECT e.id, e.created_at, e.from_status, e.to_status, e.attempt,
             j.id AS job_id, j.project_id, j.content_item_id, j.production_run_id, j.kind,
             s.scene_number, c.title
        FROM job_events e
        JOIN generation_jobs j ON j.project_id = e.project_id AND j.id = e.job_id
        JOIN content_items c ON c.project_id = j.project_id AND c.id = j.content_item_id
        LEFT JOIN storyboard_scenes s ON s.id = j.storyboard_scene_id
       WHERE e.created_at > ${from}
       ORDER BY e.created_at, e.id
       LIMIT ${limit}`;
  }
}
