import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { ApiEnv } from '@acf/config';

import { API_ENV } from '../config/api-config.module.js';

/**
 * Shared Redis connection for API-side coordination (health, later: BullMQ producers).
 * Redis is transport/cache only — never the source of truth (ADR-002/003).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: env.HEALTH_CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      // Keep reconnecting in the background with capped backoff; readiness reports state.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // Without a listener, ioredis emits unhandled 'error' events while Redis is down.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      this.client.disconnect();
      return;
    }
    await this.client.quit().catch(() => {
      this.client.disconnect();
    });
  }
}
