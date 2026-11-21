import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode } from '@acf/contracts';
import type { ApiEnv } from '@acf/config';

import { ApiError } from '../common/api-error.js';
import type { Actor } from './actor.js';

/**
 * Platform operators (P1 design O1): the users named in `OPERATOR_EMAILS`. They alone may change
 * the global AI registry (providers, models, routes) over HTTP; project roles do not apply.
 */
export function isOperator(env: Pick<ApiEnv, 'OPERATOR_EMAILS'>, actor: Actor): boolean {
  return env.OPERATOR_EMAILS.includes(actor.user.email.toLowerCase());
}

export function requireOperator(env: Pick<ApiEnv, 'OPERATOR_EMAILS'>, actor: Actor): void {
  if (!isOperator(env, actor)) {
    throw new ApiError({
      status: HttpStatus.FORBIDDEN,
      code: ApiErrorCode.Forbidden,
      message: 'Only platform operators can change AI settings.',
    });
  }
}
