import { SetMetadata } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';

export const PUBLIC_METADATA = 'acf:public';

/** `true`, or a predicate on the environment (e.g. OpenAPI only when `OPENAPI_PUBLIC`). */
export type PublicRule = true | ((env: ApiEnv) => boolean);

/**
 * Opts a route out of the session requirement (and therefore CSRF). Public handlers must never
 * write to `req.session` (design package §5.3.1); a test asserts they set no session cookie.
 * The Origin check still applies to their state-changing methods.
 */
export const Public = (rule: PublicRule = true) => SetMetadata(PUBLIC_METADATA, rule);
