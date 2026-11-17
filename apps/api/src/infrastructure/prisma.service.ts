import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';
import { createPrismaClient, type PrismaClient } from '@acf/database';

import { API_ENV } from '../config/api-config.module.js';

/**
 * Owns the process-wide Prisma client. The client connects lazily on first query,
 * so constructing this service has no I/O side effects.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = createPrismaClient({
      databaseUrl: env.DATABASE_URL,
      maxConnections: env.DATABASE_POOL_MAX,
      // Pool wait for all queries. The readiness probe has its own, shorter deadline
      // (HEALTH_CHECK_TIMEOUT_MS, enforced in HealthService).
      connectionTimeoutMs: env.DATABASE_POOL_TIMEOUT_MS,
    });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
