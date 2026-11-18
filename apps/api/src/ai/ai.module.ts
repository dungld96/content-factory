import { Module } from '@nestjs/common';

import type { ImageProvider, LlmProvider } from '@acf/ai-core';
import {
  createImageProviders,
  createLlmProviders,
  ImageService,
  LlmService,
  ModelCatalog,
} from '@acf/ai-runtime';
import { inspectImage } from '@acf/storage';
import type { ApiEnv } from '@acf/config';

import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { IMAGE_PROVIDERS, LLM_PROVIDERS } from './ai.tokens.js';
import { RegistryController } from './registry/registry.controller.js';
import { RegistryService } from './registry/registry.service.js';

/**
 * AI core wiring (M2 design §3.2). The runtime classes live in `@acf/ai-runtime` (M3 Q1) and are
 * shared with the worker; this module only provides them through Nest DI.
 */
@Module({
  controllers: [RegistryController],
  providers: [
    {
      provide: LLM_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createLlmProviders(env),
    },
    {
      provide: IMAGE_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createImageProviders(env),
    },
    {
      provide: ModelCatalog,
      inject: [PrismaService, LLM_PROVIDERS, IMAGE_PROVIDERS],
      useFactory: (
        prisma: PrismaService,
        providers: ReadonlyMap<string, LlmProvider>,
        imageProviders: ReadonlyMap<string, ImageProvider>,
      ) => new ModelCatalog(prisma.client, providers, imageProviders),
    },
    {
      // Routing and estimates in the API; the worker makes the calls (M4 design §5).
      provide: ImageService,
      inject: [PrismaService, ModelCatalog, IMAGE_PROVIDERS],
      useFactory: (
        prisma: PrismaService,
        catalog: ModelCatalog,
        providers: ReadonlyMap<string, ImageProvider>,
      ) =>
        new ImageService(prisma.client, catalog, providers, {
          pixelsOf: (bytes) => {
            try {
              const image = inspectImage(bytes);
              return image.width * image.height;
            } catch {
              return null;
            }
          },
        }),
    },
    {
      provide: LlmService,
      inject: [PrismaService, ModelCatalog, LLM_PROVIDERS, API_ENV],
      useFactory: (
        prisma: PrismaService,
        catalog: ModelCatalog,
        providers: ReadonlyMap<string, LlmProvider>,
        env: ApiEnv,
      ) =>
        new LlmService(prisma.client, catalog, providers, {
          providerTimeoutMs: env.OPENROUTER_TIMEOUT_MS,
        }),
    },
    RegistryService,
  ],
  exports: [LlmService, ModelCatalog, ImageService, RegistryService],
})
export class AiModule {}
