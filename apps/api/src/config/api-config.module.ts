import { Global, Module, type DynamicModule } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';

/** Injection token for the validated, immutable API environment. */
export const API_ENV = Symbol('API_ENV');

/**
 * Exposes the already-validated environment to the DI container.
 * Validation happens in `main.ts` *before* Nest boots, so the process fails fast.
 */
@Global()
@Module({})
export class ApiConfigModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: ApiConfigModule,
      providers: [{ provide: API_ENV, useValue: Object.freeze({ ...env }) }],
      exports: [API_ENV],
    };
  }
}
