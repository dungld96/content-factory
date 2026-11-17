#!/usr/bin/env node
// Validates the API and web environment (shell + repository-root .env) without starting anything.
// Prints variable names and problems only — never values.
import path from 'node:path';

import { EnvValidationError, loadApiEnv, loadWebServerEnv } from '@acf/config';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'));
} catch {
  console.warn('No .env file found; validating the current process environment only.');
}

let failed = false;
for (const [scope, load] of [
  ['api', loadApiEnv],
  ['web', loadWebServerEnv],
]) {
  try {
    load(process.env);
    console.info(`✔ ${scope} environment is valid`);
  } catch (error) {
    failed = true;
    console.error(error instanceof EnvValidationError ? error.message : error);
  }
}
process.exit(failed ? 1 : 0);
