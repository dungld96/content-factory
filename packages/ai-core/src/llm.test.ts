import { describe, expect, it } from 'vitest';

import { ProviderError } from './errors.js';
import { parseLlmRequest, requiredLlmParameters, type LlmRequest } from './llm.js';

const valid = {
  modelKey: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Write a hook.' }],
  maxOutputTokens: 64,
};

function rejection(input: unknown): ProviderError {
  try {
    parseLlmRequest(input);
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('parseLlmRequest', () => {
  it('accepts a minimal request', () => {
    expect(parseLlmRequest(valid)).toEqual(valid);
  });

  it('accepts every optional parameter', () => {
    const full = {
      ...valid,
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
      stop: ['END'],
      responseFormat: {
        type: 'json_schema',
        name: 'script',
        strict: true,
        schema: { type: 'object' },
      },
      dataPolicy: { zeroDataRetention: true },
    };
    expect(parseLlmRequest(full)).toEqual(full);
  });

  it.each([
    ['no messages', { ...valid, messages: [] }, 'messages'],
    [
      'empty content',
      { ...valid, messages: [{ role: 'user', content: '' }] },
      'messages.0.content',
    ],
    ['unknown role', { ...valid, messages: [{ role: 'tool', content: 'x' }] }, 'messages.0.role'],
    ['no max tokens', { modelKey: 'm', messages: valid.messages }, 'maxOutputTokens'],
    ['zero max tokens', { ...valid, maxOutputTokens: 0 }, 'maxOutputTokens'],
    ['temperature > 2', { ...valid, temperature: 2.5 }, 'temperature'],
    ['topP = 0', { ...valid, topP: 0 }, 'topP'],
    ['five stops', { ...valid, stop: ['a', 'b', 'c', 'd', 'e'] }, 'stop'],
    [
      'bad schema name',
      { ...valid, responseFormat: { type: 'json_schema', name: 'a b', schema: {}, strict: true } },
      'responseFormat.name',
    ],
    ['unknown field', { ...valid, provider: { order: ['x'] } }, '(root)'],
  ])('rejects %s as INVALID_REQUEST, not sent', (_name, input, field) => {
    const error = rejection(input);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.outcome).toBe('not_sent');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(field);
  });

  it('never echoes message content in the error', () => {
    const secret = 'confidential brief text';
    const error = rejection({ ...valid, messages: [{ role: 'nobody', content: secret }] });
    expect(error.message).not.toContain(secret);
  });
});

describe('requiredLlmParameters', () => {
  const base = parseLlmRequest(valid);

  it('always requires max_tokens', () => {
    expect([...requiredLlmParameters(base)]).toEqual(['max_tokens']);
  });

  it('lists every parameter the request sets', () => {
    const request: LlmRequest = {
      ...base,
      temperature: 0,
      topP: 1,
      seed: 1,
      stop: ['x'],
      responseFormat: { type: 'json_schema', name: 's', schema: {}, strict: true },
    };
    expect([...requiredLlmParameters(request)].sort()).toEqual([
      'max_tokens',
      'response_format',
      'seed',
      'stop',
      'structured_outputs',
      'temperature',
      'top_p',
    ]);
  });

  it('plain text output needs no response_format support', () => {
    const request: LlmRequest = { ...base, responseFormat: { type: 'text' } };
    expect([...requiredLlmParameters(request)]).toEqual(['max_tokens']);
  });
});
