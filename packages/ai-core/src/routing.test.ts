import { describe, expect, it } from 'vitest';

import { meetsQualityTier } from './capability.js';
import { effectiveParameters, filterCandidates, type ModelCandidate } from './routing.js';

const candidate = (overrides: Partial<ModelCandidate> = {}): ModelCandidate => ({
  modelId: 'm1',
  modelKey: 'deepseek/deepseek-v4-flash',
  providerKey: 'openrouter',
  capabilities: ['llm'],
  supportedParameters: ['max_tokens', 'seed', 'response_format', 'structured_outputs'],
  qualityTier: 'balanced',
  modelStatus: 'enabled',
  providerStatus: 'enabled',
  providerConfigured: true,
  ...overrides,
});

const llm = (parameters: string[] = ['max_tokens']) => ({
  capability: 'llm' as const,
  parameters: new Set(parameters),
  minimumTier: 'economy' as const,
});

describe('filterCandidates', () => {
  it('keeps a candidate that meets every requirement and explains it', () => {
    const decision = filterCandidates([candidate()], llm(['max_tokens', 'seed']));
    expect(decision.eligible).toHaveLength(1);
    expect(decision.rejected).toHaveLength(0);
    expect(decision.explanation).toEqual(['deepseek/deepseek-v4-flash (openrouter): eligible']);
  });

  it.each<[string, Partial<ModelCandidate>, string]>([
    ['provider disabled', { providerStatus: 'disabled' }, 'provider_not_enabled'],
    ['provider degraded', { providerStatus: 'degraded' }, 'provider_not_enabled'],
    ['provider without credentials', { providerConfigured: false }, 'provider_not_configured'],
    ['model disabled', { modelStatus: 'disabled' }, 'model_not_enabled'],
    ['model degraded', { modelStatus: 'degraded' }, 'model_not_enabled'],
    ['no llm capability', { capabilities: ['image_generation'] }, 'capability_unsupported'],
    ['economy below balanced', { qualityTier: 'economy' }, 'below_quality_tier'],
  ])('rejects: %s', (_name, overrides, reason) => {
    const decision = filterCandidates([candidate(overrides)], {
      ...llm(),
      minimumTier: 'balanced',
    });
    expect(decision.eligible).toHaveLength(0);
    expect(decision.rejected[0]?.reasons).toEqual([reason]);
  });

  it('never routes to a model that lacks a required parameter, and names it', () => {
    const decision = filterCandidates(
      [candidate({ supportedParameters: ['max_tokens', 'response_format'] })],
      llm(['max_tokens', 'response_format', 'structured_outputs', 'seed']),
    );
    expect(decision.eligible).toHaveLength(0);
    expect(decision.rejected[0]?.missingParameters).toEqual(['seed', 'structured_outputs']);
    expect(decision.explanation[0]).toBe(
      'deepseek/deepseek-v4-flash (openrouter): rejected (parameter_unsupported) [missing: seed, structured_outputs]',
    );
  });

  it('restricts to the requested model and reports every reason', () => {
    const other = candidate({ modelId: 'm2', modelKey: 'other/model', modelStatus: 'disabled' });
    const decision = filterCandidates([candidate(), other], {
      ...llm(),
      modelKey: 'deepseek/deepseek-v4-flash',
    });
    expect(decision.eligible.map((c) => c.modelKey)).toEqual(['deepseek/deepseek-v4-flash']);
    expect(decision.rejected[0]?.reasons).toEqual(['not_requested', 'model_not_enabled']);
  });

  it('returns nothing eligible for no candidates', () => {
    expect(filterCandidates([], llm())).toEqual({ eligible: [], rejected: [], explanation: [] });
  });
});

describe('effectiveParameters', () => {
  it('limits model parameters to what the adapter can send', () => {
    expect(
      effectiveParameters(['seed', 'tools', 'max_tokens'], new Set(['max_tokens', 'seed'])),
    ).toEqual(['seed', 'max_tokens']);
  });
});

describe('meetsQualityTier', () => {
  it('orders economy < balanced < premium', () => {
    expect(meetsQualityTier('premium', 'balanced')).toBe(true);
    expect(meetsQualityTier('balanced', 'balanced')).toBe(true);
    expect(meetsQualityTier('economy', 'balanced')).toBe(false);
  });
});
