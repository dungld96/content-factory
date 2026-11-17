import { ConsoleLogger, type INestApplication, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { ApiEnv } from '@acf/config';
import { CORRELATION_ID_HEADER } from '@acf/contracts';

import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { correlationIdMiddleware } from './common/correlation-id.js';
import { createRequestLoggingMiddleware } from './common/request-logging.js';

export const API_PREFIX = 'api/v1';

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

export function createLogger(env: Pick<ApiEnv, 'LOG_LEVEL' | 'LOG_JSON'>): ConsoleLogger {
  const threshold = LEVELS.indexOf(env.LOG_LEVEL);
  return new ConsoleLogger({
    json: env.LOG_JSON,
    colors: !env.LOG_JSON,
    logLevels: LEVELS.slice(0, threshold + 1),
  });
}

/** Configures an app instance identically for runtime and tests. */
export function configureApp(app: INestApplication, env: ApiEnv, logger: ConsoleLogger): void {
  app.setGlobalPrefix(API_PREFIX);
  app.use(correlationIdMiddleware);
  app.use(createRequestLoggingMiddleware(logger));
  app.useGlobalFilters(new ApiExceptionFilter());
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
  app.disable('x-powered-by');
  configureApp(app, env, logger);
  return app;
}
