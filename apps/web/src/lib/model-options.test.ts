import { describe, expect, it } from 'vitest';

import type { AiModelDto, AiProviderDto } from '@acf/contracts';

import { usableModels } from './model-options';

const provider = (key: string, status: AiProviderDto['status'], configured: boolean) =>
  ({ key, status, configured }) as AiProviderDto;
const model = (modelKey: string, providerKey: string, status: AiModelDto['status']) =>
  ({ id: modelKey, modelKey, providerKey, status }) as AiModelDto;

describe('usableModels (P1 O7)', () => {
  it('keeps enabled models of enabled providers that have a key', () => {
    const providers = [
      provider('a', 'enabled', true),
      provider('b', 'enabled', false),
      provider('c', 'disabled', true),
    ];
    const models = [
      model('a/ok', 'a', 'enabled'),
      model('a/off', 'a', 'disabled'),
      model('b/nokey', 'b', 'enabled'),
      model('c/disabled-provider', 'c', 'enabled'),
    ];
    expect(usableModels(models, providers).map((m) => m.modelKey)).toEqual(['a/ok']);
  });
});
