import { Module } from '@nestjs/common';

import { PrismaService } from '../infrastructure/prisma.service.js';
import { RedisService } from '../infrastructure/redis.service.js';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { READINESS_PROBES, type ReadinessProbes } from './readiness-probe.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: READINESS_PROBES,
      inject: [PrismaService, RedisService],
      useFactory: (prisma: PrismaService, redis: RedisService): ReadinessProbes => ({
        database: () => prisma.ping(),
        redis: () => redis.ping(),
      }),
    },
  ],
})
export class HealthModule {}
