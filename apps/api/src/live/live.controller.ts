import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  activeJobsSchema,
  jobChangesQuerySchema,
  jobChangesSchema,
  liveCursorSchema,
  type ActiveJobsDto,
  type JobChangesDto,
} from '@acf/contracts';

import { CurrentActor, type Actor } from '../auth/actor.js';
import { Endpoint, ValidQuery } from '../common/http/endpoint.js';
import { nowCursor } from './live-cursor.js';
import { LiveEventsService } from './live-events.service.js';

const tags = ['live'];
/** Below the 30–60 s idle timeouts of common proxies (package §5). */
export const HEARTBEAT_MS = 25_000;

const streamQuerySchema = z.strictObject({ since: liveCursorSchema.optional() });

/**
 * Live job tracking (redesign R-D5): a Server-Sent Events stream, a polling fallback with ETag,
 * and the snapshot both start from. Every stream and poll is limited to the caller's projects.
 */
@Controller()
export class LiveController {
  constructor(private readonly live: LiveEventsService) {}

  @Get('jobs/active')
  @Header('Cache-Control', 'no-store')
  @Endpoint({
    summary: "The caller's queued and running jobs and the live cursor",
    tags,
    responses: { 200: { description: 'Active jobs', schema: activeJobsSchema } },
    errors: [401],
  })
  async active(@CurrentActor() actor: Actor): Promise<ActiveJobsDto> {
    return this.live.active(await this.live.projectsOf(actor.userId));
  }

  @Get('jobs/changes')
  @Endpoint({
    summary: 'Job state changes after a cursor (polling fallback of the event stream)',
    tags,
    query: jobChangesQuerySchema,
    responses: {
      200: { description: 'Changes', schema: jobChangesSchema },
      304: { description: 'Nothing new since the ETag' },
    },
    errors: [400, 401],
  })
  async changes(
    @CurrentActor() actor: Actor,
    @ValidQuery() query: z.infer<typeof jobChangesQuerySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JobChangesDto | undefined> {
    const result = await this.live.changes(query.since, await this.live.projectsOf(actor.userId));
    const etag = `"${result.cursor}-${String(result.events.length)}-${result.resync ? 'r' : 'n'}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return undefined;
    }
    return result;
  }

  @Get('events')
  @Endpoint({
    summary: 'Server-Sent Events: job state changes of the caller’s projects',
    tags,
    query: streamQuerySchema,
    responses: {
      200: { description: 'text/event-stream of LiveJobEvent', binary: ['text/event-stream'] },
    },
    errors: [400, 401],
  })
  async stream(
    @CurrentActor() actor: Actor,
    @ValidQuery() query: z.infer<typeof streamQuerySchema>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const projectIds = await this.live.projectsOf(actor.userId);
    const header = req.headers['last-event-id'];
    const lastId =
      typeof header === 'string' && liveCursorSchema.safeParse(header).success ? header : undefined;
    const since = lastId ?? query.since;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    write('retry: 5000\n\n');

    const sent = new Set<string>();
    const unsubscribe = this.live.subscribe({
      projectIds,
      send: (event) => {
        if (sent.has(event.id)) return;
        sent.add(event.id);
        if (sent.size > 5_000) sent.clear();
        write(`id: ${event.id}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
      },
    });
    if (since) {
      const backlog = await this.live.changes(since, projectIds);
      if (backlog.resync) write(`id: ${backlog.cursor}\nevent: resync\ndata: {}\n\n`);
      for (const event of backlog.events) {
        if (sent.has(event.id)) continue;
        sent.add(event.id);
        write(`id: ${event.id}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } else {
      write(`event: ready\ndata: ${JSON.stringify({ cursor: nowCursor() })}\n\n`);
    }
    const heartbeat = setInterval(() => {
      write('event: ping\ndata: {}\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
