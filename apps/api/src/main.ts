import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { EnvValidationError, loadApiEnv, redactUrl } from '@acf/config';

import { API_PREFIX, createApp } from './app.factory.js';

async function bootstrap(): Promise<void> {
  // Validate configuration before Nest boots so misconfiguration fails fast and clearly.
  const env = loadApiEnv(process.env);
  const app = await createApp(env);
  await app.listen(env.API_PORT, env.API_HOST);
  new Logger('Bootstrap').log({
    msg: 'api_started',
    url: `http://${env.API_HOST}:${env.API_PORT}/${API_PREFIX}`,
    database: redactUrl(env.DATABASE_URL),
    redis: redactUrl(env.REDIS_URL),
    nodeEnv: env.NODE_ENV,
  });
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // Message lists variable names and problems only — safe to print.
    console.error(error.message);
  } else {
    console.error('API failed to start:', error instanceof Error ? error.stack : 'unknown error');
  }
  process.exit(1);
});
