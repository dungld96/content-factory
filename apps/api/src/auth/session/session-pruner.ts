import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { PrismaSessionStore } from './prisma-session-store.js';

export const SESSION_PRUNE_INTERVAL_MS = Symbol('SESSION_PRUNE_INTERVAL_MS');

/** Hourly housekeeping of expired session rows. Correctness never depends on it. */
@Injectable()
export class SessionPruner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SessionPruner.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: PrismaSessionStore,
    @Inject(SESSION_PRUNE_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.store.pruneExpired().then(
        (count) => {
          if (count > 0) this.logger.log({ msg: 'sessions_pruned', count });
        },
        (error: unknown) => {
          this.logger.warn({
            msg: 'session_prune_failed',
            errorName: error instanceof Error ? error.name : typeof error,
          });
        },
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}
