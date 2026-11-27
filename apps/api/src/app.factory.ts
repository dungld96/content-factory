import { ConsoleLogger, type INestApplication, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { redactValue, type ApiEnv } from '@acf/config';
import { CORRELATION_ID_HEADER } from '@acf/contracts';

import { AppModule } from './app.module.js';
import { PrismaSessionStore } from './auth/session/prisma-session-store.js';
import { createSessionMiddleware } from './auth/session/session.middleware.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { correlationIdMiddleware } from './common/correlation-id.js';
import { RequestValidationInterceptor } from './common/http/endpoint.js';
import { EtagInterceptor } from './common/http/etag.interceptor.js';
import { REQUIRE_IF_MATCH_SETTING } from './common/http/etag.js';
import { API_PREFIX } from './common/http/prefix.js';
import { createRequestLoggingMiddleware } from './common/request-logging.js';

export { API_PREFIX };

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Nest's console logger with every message and parameter redacted (M7 design §10): credentials
 * never reach the logs, whatever a caller passes (error stacks, provider bodies, URLs).
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    super.printMessages(
      messages.map((m) => redactValue(m)),
      context,
      logLevel,
      writeStreamType,
      redactValue(errorStack),
    );
  }
}

export function createLogger(env: Pick<ApiEnv, 'LOG_LEVEL' | 'LOG_JSON'>): ConsoleLogger {
  const threshold = LEVELS.indexOf(env.LOG_LEVEL);
  return new RedactingConsoleLogger({
    json: env.LOG_JSON,
    colors: !env.LOG_JSON,
    logLevels: LEVELS.slice(0, threshold + 1),
  });
}

/** Configures an app instance identically for runtime and tests. */
export function configureApp(app: INestApplication, env: ApiEnv, logger: ConsoleLogger): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  express.set(REQUIRE_IF_MATCH_SETTING, env.REQUIRE_IF_MATCH);
  // Which hops may set X-Forwarded-*: the Next.js server only (ADR-0009, design §5.6).
  express.set('trust proxy', env.TRUST_PROXY);
  app.setGlobalPrefix(API_PREFIX);
  app.use(correlationIdMiddleware);
  app.use(createRequestLoggingMiddleware(logger));
  app.use(helmet());
  app.use(cookieParser()); // csrf-csrf reads its cookie from req.cookies
  app.use(createSessionMiddleware(env, app.get(PrismaSessionStore)));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new RequestValidationInterceptor(), new EtagInterceptor());
  app.enableCors({
    origin: env.API_CORS_ORIGINS,
    exposedHeaders: [CORRELATION_ID_HEADER],
  });
  app.enableShutdownHooks();
}

export async function createApp(env: ApiEnv): Promise<NestExpressApplication> {
  const logger = createLogger(env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    logger,
    bufferLogs: true,
  });
  configureApp(app, env, logger);
  return app;
}
