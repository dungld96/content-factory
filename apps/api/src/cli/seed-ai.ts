// Development seed for the AI registry (M2 decision S1). Idempotent. Uses the same mapping and
// import code as `pnpm ai:registry model import-openrouter`, fed with the default-view catalog
// snapshot in docs/design/m2/openrouter-verification.md §5 (2026-11-17T16:05:34Z). Catalog prices
// are the default endpoint's; the endpoint that serves a call may charge more or less (§5.1), so
// these are estimates and the provider-reported cost stays authoritative. Every model starts DISABLED: none
// has been benchmarked (AI_PROVIDER_STRATEGY §9) and their commercial terms are unreviewed.
import type { Prisma, PrismaClient } from '@acf/database';

import { catalogUrl, planCatalogModel } from '../ai/providers/openrouter-catalog.js';
import { imageEndpointsUrl, planImageModel } from '../ai/providers/openrouter-image-catalog.js';
import {
  planTtsModel,
  planVideoModel,
  type SpeechModelRecord,
  type VideoModelRecord,
} from '../ai/providers/openrouter-media-catalog.js';
import {
  OPENROUTER_PROVIDER_ROW,
  RegistryAdminService,
  type ImportOutcome,
} from '../ai/registry/registry-admin.service.js';
import {
  MEDIA_CATALOG_SNAPSHOT_AT,
  TTS_CATALOG_SNAPSHOT,
  VIDEO_CATALOG_SNAPSHOT,
} from './seed-media-snapshot.js';

/** When the snapshot was taken (UTC). Used as effective/captured time of the seeded prices. */
export const CATALOG_SNAPSHOT_AT = new Date('2026-11-17T16:05:34Z');

/** Catalog entries as published on 2026-11-17 (USD per token; only the fields we map). */
export const CATALOG_SNAPSHOT: readonly unknown[] = [
  {
    id: 'deepseek/deepseek-v4-flash',
    canonical_slug: 'deepseek/deepseek-v4-flash-20260423',
    name: 'DeepSeek: DeepSeek V4 Flash',
    context_length: 1_048_576,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.00000009', completion: '0.00000018', input_cache_read: '0.000000018' },
    top_provider: { max_completion_tokens: 393_216 },
    supported_parameters: [
      'max_tokens',
      'response_format',
      'seed',
      'stop',
      'structured_outputs',
      'temperature',
      'top_p',
    ],
    expiration_date: null,
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    canonical_slug: 'google/gemini-3.5-flash-lite-20260721',
    name: 'Google: Gemini 3.5 Flash Lite',
    context_length: 1_048_576,
    architecture: {
      input_modalities: ['text', 'image', 'video', 'file', 'audio'],
      output_modalities: ['text'],
    },
    pricing: {
      prompt: '0.0000003',
      completion: '0.0000025',
      input_cache_read: '0.00000003',
      input_cache_write: '0.0000000833333333333333',
      internal_reasoning: '0.0000025',
    },
    top_provider: { max_completion_tokens: 65_536 },
    supported_parameters: [
      'max_tokens',
      'response_format',
      'seed',
      'stop',
      'structured_outputs',
      'temperature',
      'top_p',
    ],
    expiration_date: null,
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    canonical_slug: 'anthropic/claude-haiku-5.5-20261007',
    name: 'Anthropic: Claude Haiku 5.5',
    context_length: 1_000_000,
    architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
    pricing: {
      prompt: '0.0000001',
      completion: '0.0000005',
      input_cache_read: '0.00000001',
      input_cache_write: '0.000000125',
      overrides: [
        {
          min_prompt_tokens: 100_000,
          prompt: '0.0000005',
          completion: '0.0000025',
          input_cache_read: '0.00000005',
          input_cache_write: '0.000000625',
        },
      ],
    },
    top_provider: { max_completion_tokens: 128_000 },
    supported_parameters: ['max_tokens', 'response_format', 'stop', 'structured_outputs'],
    expiration_date: null,
  },
];

/**
 * Image benchmark candidates (M4 design §3.3) as published on 2026-11-18 (verification record
 * docs/design/m4/openrouter-image-verification.md §2). Seeded DISABLED: none is benchmarked yet.
 */
export const IMAGE_CATALOG_SNAPSHOT_AT = new Date('2026-11-18T13:46:45Z');
export const IMAGE_CATALOG_SNAPSHOT = [
  {
    id: 'black-forest-labs/flux-3-image-klein',
    endpoints: [
      {
        provider_slug: 'black-forest-labs',
        supported_parameters: {
          aspect_ratio: {
            type: 'enum',
            values: [
              '21:9',
              '2:1',
              '16:9',
              '3:2',
              '7:5',
              '4:3',
              '5:4',
              '1:1',
              '4:5',
              '3:4',
              '5:7',
              '2:3',
              '1:2',
              '9:16',
              '9:21',
            ],
          },
          input_references: { type: 'range', min: 0, max: 10 },
          n: { type: 'range', min: 1, max: 1 },
          output_format: { type: 'enum', values: ['png', 'jpeg', 'webp'] },
          resolution: { type: 'enum', values: ['768', '1K', '1.5K', '2K', '4K'] },
          seed: { type: 'boolean' },
        },
        pricing: [
          { billable: 'output_image', unit: 'image', cost_usd: 0.008, variant: '768' },
          { billable: 'output_image', unit: 'image', cost_usd: 0.009, variant: '1k' },
          { billable: 'output_image', unit: 'image', cost_usd: 0.011, variant: '1.5k' },
          { billable: 'output_image', unit: 'image', cost_usd: 0.014, variant: '2k' },
          { billable: 'output_image', unit: 'image', cost_usd: 0.036, variant: '4k' },
        ],
      },
    ],
  },
  {
    id: 'bytedance-seed/seedream-5-0-flash',
    endpoints: [
      {
        provider_slug: 'seed',
        supported_parameters: {
          aspect_ratio: {
            type: 'enum',
            values: [
              '1:1',
              '1:2',
              '2:1',
              '2:3',
              '3:2',
              '3:4',
              '4:3',
              '4:5',
              '5:4',
              '9:16',
              '16:9',
              '9:19.5',
            ],
          },
          input_references: { type: 'range', min: 0, max: 14 },
          n: { type: 'range', min: 1, max: 1 },
          resolution: { type: 'enum', values: ['1K', '1.5K', '2K'] },
          seed: { type: 'boolean' },
        },
        pricing: [
          { billable: 'output_image', unit: 'image', cost_usd: 0.018 },
          { billable: 'input_image', unit: 'image', cost_usd: 0 },
        ],
      },
    ],
  },
  {
    id: 'qwen/qwen-image-2.1-turbo',
    endpoints: [
      {
        provider_slug: 'alibaba',
        supported_parameters: {
          aspect_ratio: {
            type: 'enum',
            values: [
              '1:1',
              '1:2',
              '1:4',
              '2:1',
              '2:3',
              '3:2',
              '3:4',
              '4:1',
              '4:3',
              '4:5',
              '5:4',
              '9:16',
              '16:9',
            ],
          },
          input_references: { type: 'range', min: 0, max: 10 },
          n: { type: 'range', min: 1, max: 6 },
          resolution: { type: 'enum', values: ['1K', '2K'] },
          seed: { type: 'boolean' },
        },
        pricing: [
          { billable: 'input_image', unit: 'image', cost_usd: 0 },
          { billable: 'output_image', unit: 'image', cost_usd: 0.0184, variant: '1k' },
          { billable: 'output_image', unit: 'image', cost_usd: 0.0184, variant: '2k' },
        ],
      },
    ],
  },
] as const;

/** The development mock image model (free, offline): routed for image generation by default. */
export const MOCK_IMAGE_MODEL_KEY = 'mock/solid-image';
/** Free mock media models (M5): routed by default in development and E2E (seeded in M5c). */
export const MOCK_VIDEO_MODEL_KEY = 'mock/still-video';
export const MOCK_TTS_MODEL_KEY = 'mock/tone-tts';

/** An enabled, free mock model for video or TTS (idempotent). */
async function seedMockMediaModel(
  prisma: PrismaClient,
  providerId: string,
  m: {
    modelKey: string;
    displayName: string;
    capability: 'video_generation' | 'tts';
    outputModalities: string[];
    mediaConstraints: Record<string, unknown>;
    metric: 'output_video_seconds' | 'input_characters';
  },
): Promise<void> {
  const existing = await prisma.aiModel.findUnique({
    where: { providerId_modelKey: { providerId, modelKey: m.modelKey } },
  });
  if (existing) return;
  await prisma.$transaction(async (tx) => {
    const model = await tx.aiModel.create({
      data: {
        providerId,
        modelKey: m.modelKey,
        displayName: m.displayName,
        supportedParameters: [],
        inputModalities: m.capability === 'tts' ? ['text'] : ['text', 'image'],
        outputModalities: m.outputModalities,
        mediaConstraints: m.mediaConstraints as Prisma.InputJsonObject,
        qualityTier: 'premium',
        status: 'enabled',
        capabilities: { create: { capability: m.capability } },
      },
    });
    await tx.aiModelPrice.create({
      data: {
        modelId: model.id,
        metric: m.metric,
        unitPrice: '0',
        sourceValue: '0',
        effectiveFrom: MEDIA_CATALOG_SNAPSHOT_AT,
        source: 'manual_estimate',
        sourceUrl: 'urn:acf:mock',
        capturedAt: MEDIA_CATALOG_SNAPSHOT_AT,
      },
    });
  });
}

export interface AiSeedResult {
  readonly openrouterStatus: string;
  readonly models: readonly ImportOutcome[];
}

export async function seedAiRegistry(
  prisma: PrismaClient,
  options: { openrouterConfigured: boolean },
): Promise<AiSeedResult> {
  const provider = await prisma.aiProvider.upsert({
    where: { key: OPENROUTER_PROVIDER_ROW.key },
    create: {
      ...OPENROUTER_PROVIDER_ROW,
      status: options.openrouterConfigured ? 'enabled' : 'disabled',
    },
    update: {},
  });
  const admin = new RegistryAdminService(prisma);
  const models = await admin.applyOpenRouterImport(CATALOG_SNAPSHOT.map(planCatalogModel), {
    tier: 'economy',
    sourceUrl: catalogUrl('https://openrouter.ai/api/v1'),
    now: CATALOG_SNAPSHOT_AT,
  });

  // A deterministic provider for local development and tests (no adapter in production code:
  // it is reported `configured: false` unless a test registers MockLlmProvider).
  const mock = await prisma.aiProvider.upsert({
    where: { key: 'mock' },
    create: {
      key: 'mock',
      name: 'Mock (development)',
      kind: 'mock',
      status: 'enabled',
      notes: 'Deterministic test double; never calls a network service. Prices are zero.',
    },
    update: {},
  });
  const existing = await prisma.aiModel.findUnique({
    where: { providerId_modelKey: { providerId: mock.id, modelKey: 'mock/echo' } },
  });
  if (!existing) {
    await prisma.$transaction(async (tx) => {
      const model = await tx.aiModel.create({
        data: {
          providerId: mock.id,
          modelKey: 'mock/echo',
          displayName: 'Mock echo',
          supportedParameters: [
            'max_tokens',
            'response_format',
            'seed',
            'stop',
            'structured_outputs',
            'temperature',
            'top_p',
          ],
          inputModalities: ['text'],
          outputModalities: ['text'],
          qualityTier: 'economy',
          status: 'enabled',
          capabilities: { create: { capability: 'llm' } },
        },
      });
      for (const metric of ['input_tokens', 'output_tokens'] as const) {
        await tx.aiModelPrice.create({
          data: {
            modelId: model.id,
            metric,
            unitPrice: '0',
            sourceValue: '0',
            effectiveFrom: CATALOG_SNAPSHOT_AT,
            source: 'manual_estimate',
            sourceUrl: 'urn:acf:mock',
            capturedAt: CATALOG_SNAPSHOT_AT,
          },
        });
      }
    });
  }
  // Development routes (M3 Q4): both generation tasks use the mock model until an operator
  // routes them to an enabled, reviewed model. Existing routes are kept.
  const echo = await prisma.aiModel.findUniqueOrThrow({
    where: { providerId_modelKey: { providerId: mock.id, modelKey: 'mock/echo' } },
  });
  for (const task of ['script_generation', 'storyboard_generation'] as const) {
    await prisma.aiTaskRoute.upsert({
      where: { task },
      create: { task, modelId: echo.id },
      update: {},
    });
  }

  // M4: image benchmark candidates (disabled) and the mock image model, routed by default.
  const imageModels = await admin.applyOpenRouterImageImport(
    IMAGE_CATALOG_SNAPSHOT.map((entry) =>
      planImageModel(entry as unknown as Parameters<typeof planImageModel>[0]),
    ),
    {
      tier: 'balanced',
      sourceUrl: (modelKey) => imageEndpointsUrl('https://openrouter.ai/api/v1', modelKey),
      now: IMAGE_CATALOG_SNAPSHOT_AT,
    },
  );
  let mockImage = await prisma.aiModel.findUnique({
    where: { providerId_modelKey: { providerId: mock.id, modelKey: MOCK_IMAGE_MODEL_KEY } },
  });
  if (!mockImage) {
    mockImage = await prisma.$transaction(async (tx) => {
      const model = await tx.aiModel.create({
        data: {
          providerId: mock.id,
          modelKey: MOCK_IMAGE_MODEL_KEY,
          displayName: 'Mock solid-colour images',
          supportedParameters: ['aspect_ratio', 'input_references', 'n', 'resolution', 'seed'],
          inputModalities: ['text', 'image'],
          outputModalities: ['image'],
          imageConstraints: {
            maxImages: 4,
            maxReferences: 16,
            aspectRatios: ['9:16', '1:1', '16:9'],
            resolutions: ['1K', '2K'],
            seed: true,
          },
          qualityTier: 'premium',
          status: 'enabled',
          capabilities: { create: { capability: 'image_generation' } },
        },
      });
      await tx.aiModelPrice.create({
        data: {
          modelId: model.id,
          metric: 'output_images',
          unitPrice: '0',
          sourceValue: '0',
          effectiveFrom: IMAGE_CATALOG_SNAPSHOT_AT,
          source: 'manual_estimate',
          sourceUrl: 'urn:acf:mock',
          capturedAt: IMAGE_CATALOG_SNAPSHOT_AT,
        },
      });
      return model;
    });
  }
  await prisma.aiTaskRoute.upsert({
    where: { task: 'image_generation' },
    create: { task: 'image_generation', modelId: mockImage.id },
    update: {},
  });
  // M5: video and TTS benchmark candidates (disabled) and the free mock models. Their routes come
  // with the M5c job kinds (seeded there).
  const mediaModels = await admin.applyOpenRouterMediaImport(
    [
      ...VIDEO_CATALOG_SNAPSHOT.map((r) => planVideoModel(r as unknown as VideoModelRecord)),
      ...TTS_CATALOG_SNAPSHOT.map((r) => planTtsModel(r as unknown as SpeechModelRecord)),
    ],
    {
      tier: 'balanced',
      sourceUrl: (modelKey) =>
        modelKey.startsWith('elevenlabs/') || modelKey.startsWith('microsoft/')
          ? 'https://openrouter.ai/api/v1/models?output_modalities=speech'
          : 'https://openrouter.ai/api/v1/videos/models',
      now: MEDIA_CATALOG_SNAPSHOT_AT,
    },
  );
  await seedMockMediaModel(prisma, mock.id, {
    modelKey: MOCK_VIDEO_MODEL_KEY,
    displayName: 'Mock video clips (FFmpeg still from the keyframe)',
    capability: 'video_generation',
    outputModalities: ['video'],
    mediaConstraints: {
      kind: 'video',
      durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['9:16', '1:1', '16:9'],
      frameImages: ['first_frame'],
      audio: false,
      seed: true,
    },
    metric: 'output_video_seconds',
  });
  await seedMockMediaModel(prisma, mock.id, {
    modelKey: MOCK_TTS_MODEL_KEY,
    displayName: 'Mock speech (FFmpeg tone)',
    capability: 'tts',
    outputModalities: ['speech'],
    mediaConstraints: { kind: 'tts', voices: ['mock-a', 'mock-b'], mp3: true },
    metric: 'input_characters',
  });
  return {
    openrouterStatus: provider.status,
    models: [...models, ...imageModels, ...mediaModels],
  };
}
