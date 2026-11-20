import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';

import { AiModule } from './ai/ai.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BudgetsModule } from './budgets/budgets.module.js';
import { BrandModule } from './brand/brand.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { ApiConfigModule } from './config/api-config.module.js';
import { GenerationModule } from './generation/generation.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { ContentModule } from './content/content.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';
import { ProjectsModule } from './projects/projects.module.js';

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ApiConfigModule.forRoot(env),
        InfrastructureModule,
        AuthModule,
        HealthModule,
        OpenApiModule,
        ProjectsModule,
        ChannelsModule,
        ContentModule,
        BrandModule,
        AssetsModule,
        AiModule,
        BudgetsModule,
        GenerationModule,
      ],
    };
  }
}
