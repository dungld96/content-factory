// Development seed for the AI registry (M2 decision S1). Idempotent. Uses the same mapping and
// import code as `pnpm ai:registry model import-openrouter`, fed with the default-view catalog
// snapshot in docs/design/m2/openrouter-verification.md §5 (2026-11-17T16:05:34Z). Catalog prices
// are the default endpoint's; the endpoint that serves a call may charge more or less (§5.1), so
// these are estimates and the provider-reported cost stays authoritative. Every model starts DISABLED: none
// has been benchmarked (AI_PROVIDER_STRATEGY §9) and their commercial terms are unreviewed.
import type { PrismaClient } from '@acf/database';

import { catalogUrl, planCatalogModel } from '../ai/providers/openrouter-catalog.js';
import {
  OPENROUTER_PROVIDER_ROW,
  RegistryAdminService,
  type ImportOutcome,
} from '../ai/registry/registry-admin.service.js';

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
  return { openrouterStatus: provider.status, models };
}
