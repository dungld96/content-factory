import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';

import { ApiConfigModule } from './config/api-config.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [ApiConfigModule.forRoot(env), InfrastructureModule, HealthModule],
    };
  }
}
