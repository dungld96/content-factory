import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import type { ApiEnv } from '@acf/config';

import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CsrfService } from './csrf.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SecurityGuard } from './security.guard.js';
import { SessionUserService } from './session-user.service.js';
import { PrismaSessionStore } from './session/prisma-session-store.js';
import { SESSION_PRUNE_INTERVAL_MS, SessionPruner } from './session/session-pruner.js';

/** Touch writes are throttled to one per session per minute (ADR-0009 consequences). */
export const SESSION_TOUCH_THROTTLE_MS = 60_000;

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => [
        { name: 'login', ttl: 60_000, limit: env.LOGIN_RATE_LIMIT_PER_MINUTE },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: PrismaSessionStore,
      inject: [PrismaService, API_ENV],
      useFactory: (prisma: PrismaService, env: ApiEnv) =>
        new PrismaSessionStore(prisma.client, {
          absoluteTtlMs: env.SESSION_ABSOLUTE_TTL_MS,
          idleTtlMs: env.SESSION_IDLE_TTL_MS,
          touchThrottleMs: SESSION_TOUCH_THROTTLE_MS,
        }),
    },
    { provide: SESSION_PRUNE_INTERVAL_MS, useValue: 3_600_000 },
    SessionPruner,
    PasswordHasher,
    CsrfService,
    SessionUserService,
    AuthService,
    { provide: APP_GUARD, useClass: SecurityGuard },
  ],
  exports: [PrismaSessionStore, PasswordHasher],
})
export class AuthModule {}
