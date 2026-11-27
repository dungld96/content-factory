import { describe, expect, it } from 'vitest';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import type { LlmRequest } from '../llm.js';
import { UsdAmount } from '../money.js';
import { MockLlmProvider } from './mock-llm.js';

const context: GenerationContext = {
  projectId: '00000000-0000-7000-8000-000000000001',
  correlationId: 'corr-1',
  qualityTier: 'economy',
};
const request: LlmRequest = {
  modelKey: 'mock/model',
  messages: [{ role: 'user', content: 'twelve chars' }],
  maxOutputTokens: 100,
};
const live = () => new AbortController().signal;

describe('MockLlmProvider', () => {
  it('returns a deterministic default result and records the call', async () => {
    const provider = new MockLlmProvider();
    const result = await provider.complete(request, context, live());
    expect(result).toEqual({
      text: 'mock completion',
      finishReason: 'stop',
      providerRequestId: 'mock-1',
      servedModel: 'mock/model',
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      reportedCost: null,
      latencyMs: 0,
    });
    expect(provider.calls).toEqual([{ request, context }]);
  });

  it('plays scripted results and errors in order', async () => {
    const failure = new ProviderError(ProviderErrorCode.RATE_LIMITED, 'slow down', {
      outcome: ProviderErrorOutcome.REJECTED,
      retryAfterMs: 1000,
    });
    const provider = new MockLlmProvider({
      steps: [
        { kind: 'error', error: failure },
        {
          kind: 'result',
          text: 'hello',
          finishReason: 'length',
          usage: { inputTokens: 10, outputTokens: 5 },
          reportedCost: UsdAmount.parse('0.0001'),
        },
      ],
    });
    await expect(provider.complete(request, context, live())).rejects.toBe(failure);
    const second = await provider.complete(request, context, live());
    expect(second).toMatchObject({
      text: 'hello',
      finishReason: 'length',
      providerRequestId: 'mock-2',
    });
    expect(second.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(second.reportedCost?.toString()).toBe('0.0001');
    provider.enqueue({ kind: 'result', text: 'third' });
    expect((await provider.complete(request, context, live())).text).toBe('third');
  });

  it('returns JSON for structured requests by default', async () => {
    const provider = new MockLlmProvider();
    const result = await provider.complete(
      { ...request, responseFormat: { type: 'json_schema', name: 's', schema: {}, strict: true } },
      context,
      live(),
    );
    expect(JSON.parse(result.text)).toEqual({});
  });

  it('validates like a real adapter: invalid requests are not sent', async () => {
    const provider = new MockLlmProvider();
    const bad = { ...request, maxOutputTokens: 0 };
    await expect(provider.complete(bad, context, live())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      outcome: 'not_sent',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses parameters it was configured not to support', async () => {
    const provider = new MockLlmProvider({ supportedParameters: ['max_tokens'] });
    await expect(provider.complete({ ...request, seed: 1 }, context, live())).rejects.toMatchObject(
      {
        code: 'UNSUPPORTED_PARAMETER',
        outcome: 'not_sent',
        message: 'unsupported parameters: seed',
      },
    );
  });

  it('honours an aborted signal without recording a call', async () => {
    const provider = new MockLlmProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.complete(request, context, controller.signal)).rejects.toMatchObject({
      code: 'TIMEOUT',
      outcome: 'not_sent',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('constructs without side effects and copies its script', async () => {
    const steps = [{ kind: 'result' as const, text: 'a' }];
    const provider = new MockLlmProvider({ steps });
    steps.length = 0;
    expect((await provider.complete(request, context, live())).text).toBe('a');
  });
});
