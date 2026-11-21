import { Module } from '@nestjs/common';

import type { ImageProvider, LlmProvider, TtsProvider, VideoProvider } from '@acf/ai-core';
import {
  createImageProviders,
  createKeyChecks,
  createLlmProviders,
  createTtsProviders,
  createVideoProviders,
  ImageService,
  LlmService,
  ModelCatalog,
  TtsService,
  VideoService,
} from '@acf/ai-runtime';
import { inspectImage } from '@acf/storage';
import type { ApiEnv } from '@acf/config';

import { API_ENV } from '../config/api-config.module.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import {
  IMAGE_PROVIDERS,
  KEY_CHECKS,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  VIDEO_PROVIDERS,
} from './ai.tokens.js';
import { RegistryController } from './registry/registry.controller.js';
import { RegistryAdminService } from './registry/registry-admin.service.js';
import { RegistrySettingsService } from './registry/registry-settings.service.js';
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
      provide: VIDEO_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createVideoProviders(env),
    },
    {
      provide: KEY_CHECKS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createKeyChecks(env),
    },
    {
      provide: TTS_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createTtsProviders(env),
    },
    {
      provide: ModelCatalog,
      inject: [PrismaService, LLM_PROVIDERS, IMAGE_PROVIDERS, VIDEO_PROVIDERS, TTS_PROVIDERS],
      useFactory: (
        prisma: PrismaService,
        providers: ReadonlyMap<string, LlmProvider>,
        imageProviders: ReadonlyMap<string, ImageProvider>,
        videoProviders: ReadonlyMap<string, VideoProvider>,
        ttsProviders: ReadonlyMap<string, TtsProvider>,
      ) => new ModelCatalog(prisma.client, providers, imageProviders, videoProviders, ttsProviders),
    },
    {
      // Routing and estimates only (M5 design §5): the worker submits, polls and downloads.
      provide: VideoService,
      inject: [PrismaService, ModelCatalog, VIDEO_PROVIDERS],
      useFactory: (
        prisma: PrismaService,
        catalog: ModelCatalog,
        providers: ReadonlyMap<string, VideoProvider>,
      ) => new VideoService(prisma.client, catalog, providers),
    },
    {
      provide: TtsService,
      inject: [PrismaService, ModelCatalog, TTS_PROVIDERS],
      useFactory: (
        prisma: PrismaService,
        catalog: ModelCatalog,
        providers: ReadonlyMap<string, TtsProvider>,
      ) => new TtsService(prisma.client, catalog, providers),
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
    {
      // The same writes as the operator CLI (P1 O4); constructed without Nest by the CLI.
      provide: RegistryAdminService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new RegistryAdminService(prisma.client),
    },
    RegistrySettingsService,
  ],
  exports: [LlmService, ModelCatalog, ImageService, VideoService, TtsService, RegistryService],
})
export class AiModule {}
