// Deterministic LLM for end-to-end runs (M3 design §11): answers each structured-output request
// with a schema-valid sample chosen by the requested schema name. Test tooling only.
import type { LlmProvider, LlmRequest, LlmResult } from '@acf/ai-core';

import { sampleScript, sampleStoryboard } from './fixtures.js';

export function createFixtureLlmProvider(providerKey = 'mock'): LlmProvider {
  let calls = 0;
  return {
    providerKey,
    supportedParameters: new Set([
      'max_tokens',
      'temperature',
      'top_p',
      'seed',
      'stop',
      'response_format',
      'structured_outputs',
    ] as const),
    complete(request: LlmRequest): Promise<LlmResult> {
      calls += 1;
      const name =
        request.responseFormat?.type === 'json_schema' ? request.responseFormat.name : '';
      const body = name === 'storyboard_content' ? sampleStoryboard() : sampleScript();
      const text = JSON.stringify(body);
      return Promise.resolve({
        text,
        finishReason: 'stop',
        providerRequestId: `fixture-${String(calls)}`,
        servedModel: request.modelKey,
        usage: {
          inputTokens: 500,
          outputTokens: Math.ceil(text.length / 4),
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        reportedCost: null,
        latencyMs: 5,
      });
    },
  };
}
