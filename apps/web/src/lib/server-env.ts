import 'server-only';

import { loadWebServerEnv, type WebServerEnv } from '@acf/config';

let cached: WebServerEnv | undefined;

/** Validated server-side env. Importing this from a Client Component fails the build. */
export function serverEnv(): WebServerEnv {
  cached ??= loadWebServerEnv(process.env);
  return cached;
}
