import { Module } from '@nestjs/common';

import type { ApiEnv } from '@acf/config';

import { API_ENV } from '../config/api-config.module.js';
import { LLM_PROVIDERS } from './ai.tokens.js';
import { LlmService } from './llm.service.js';
import { createLlmProviders } from './providers/llm-providers.js';
import { RegistryController } from './registry/registry.controller.js';
import { RegistryService } from './registry/registry.service.js';

/**
 * AI core wiring (M2 design package §3.2): adapters are built once from validated config and
 * exposed only behind the `LlmProvider` interface. `LlmService` is the entry point for later
 * milestones (M3 script jobs); M2 exposes no endpoint that calls a model (decision P7).
 */
@Module({
  controllers: [RegistryController],
  providers: [
    {
      provide: LLM_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createLlmProviders(env),
    },
    RegistryService,
    LlmService,
  ],
  exports: [LlmService, RegistryService],
})
export class AiModule {}
