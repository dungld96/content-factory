import { describe, expect, it } from 'vitest';

import type { AiTask } from '@acf/contracts';

import {
  GatewayChoiceError,
  modelFamily,
  planGatewaySwitch,
  suggestModel,
  type CurrentRoute,
  type GatewayModel,
} from './gateway-switch.js';

const TASKS: readonly AiTask[] = [
  'script_generation',
  'storyboard_generation',
  'image_generation',
  'video_generation',
  'tts_generation',
];

const route = (providerKey: string, modelKey: string, zeroDataRetention = false): CurrentRoute => ({
  providerKey,
  modelKey,
  displayName: modelKey,
  zeroDataRetention,
});
const model = (modelKey: string): GatewayModel => ({ modelKey, displayName: modelKey });

describe('modelFamily', () => {
  it.each([
    ['anthropic/claude-haiku-5.5', 'claude-haiku-5-5'],
    ['claude-haiku-5-5', 'claude-haiku-5-5'],
    ['google/gemini-3.5-flash-lite', 'gemini-3-5-flash-lite'],
    ['gemini-3.5-flash-lite', 'gemini-3-5-flash-lite'],
    ['DeepSeek/DeepSeek_V4_Flash', 'deepseek-v4-flash'],
  ])('%s → %s', (key, family) => {
    expect(modelFamily(key)).toBe(family);
  });
});

describe('suggestModel', () => {
  const candidates = [model('gemini-3.5-flash'), model('gemini-3.5-flash-lite')];

  it('prefers the same model family', () => {
    expect(suggestModel(route('openrouter', 'google/gemini-3.5-flash-lite'), candidates)).toEqual(
      model('gemini-3.5-flash-lite'),
    );
  });

  it('falls back to the only candidate, and to none when ambiguous', () => {
    expect(
      suggestModel(route('openrouter', 'bytedance-seed/seedream-5-0-flash'), [
        model('doubao-seedream-5-5-261028'),
      ]),
    ).toEqual(model('doubao-seedream-5-5-261028'));
    expect(suggestModel(route('openrouter', 'qwen/qwen-4'), candidates)).toBeNull();
    expect(suggestModel(null, candidates)).toBeNull();
  });
});

describe('planGatewaySwitch', () => {
  const routes = new Map<AiTask, CurrentRoute>([
    ['script_generation', route('openrouter', 'google/gemini-3.5-flash-lite')],
    ['storyboard_generation', route('openrouter', 'anthropic/claude-haiku-5.5')],
    ['image_generation', route('openrouter', 'bytedance-seed/seedream-5-0-flash', true)],
    ['video_generation', route('openrouter', 'google/veo-3.1-lite')],
  ]);
  const llm = [model('claude-haiku-5-5'), model('gemini-3.5-flash-lite')];
  const candidates = new Map<AiTask, GatewayModel[]>([
    ['script_generation', llm],
    ['storyboard_generation', llm],
    ['image_generation', [model('doubao-seedream-5-5-261028')]],
  ]);
  const base = {
    providerKey: 'mixroute',
    supportsZeroDataRetention: false,
    tasks: TASKS,
    routes,
    candidates,
  };

  it('suggests equivalents and keeps what cannot move, with the reason', () => {
    const plan = planGatewaySwitch(base);
    const byTask = Object.fromEntries(plan.map((p) => [p.task, p]));
    expect(byTask['script_generation']?.target).toEqual(model('gemini-3.5-flash-lite'));
    expect(byTask['storyboard_generation']?.target).toEqual(model('claude-haiku-5-5'));
    // The image route needs ZDR, which MixRoute cannot provide.
    expect(byTask['image_generation']).toMatchObject({ target: null, keptBecause: 'zdr_required' });
    expect(byTask['video_generation']).toMatchObject({ target: null, keptBecause: 'no_candidate' });
    expect(byTask['tts_generation']).toMatchObject({ current: null, keptBecause: 'no_candidate' });
  });

  it('applies operator choices: another candidate, or keep', () => {
    const plan = planGatewaySwitch({
      ...base,
      choices: { script_generation: 'claude-haiku-5-5', storyboard_generation: null },
    });
    expect(plan.find((p) => p.task === 'script_generation')?.target).toEqual(
      model('claude-haiku-5-5'),
    );
    expect(plan.find((p) => p.task === 'storyboard_generation')).toMatchObject({
      target: null,
      keptBecause: 'not_chosen',
    });
  });

  it('refuses a choice that is not a routable candidate', () => {
    expect(() =>
      planGatewaySwitch({ ...base, choices: { script_generation: 'gpt-6.1-sol' } }),
    ).toThrow(GatewayChoiceError);
  });

  it('leaves tasks already on the gateway, and switches back to a ZDR-capable gateway', () => {
    const onMixRoute = new Map<AiTask, CurrentRoute>([
      ['script_generation', route('mixroute', 'gemini-3.5-flash-lite')],
    ]);
    const stay = planGatewaySwitch({ ...base, routes: onMixRoute });
    expect(stay.find((p) => p.task === 'script_generation')?.keptBecause).toBe(
      'already_on_gateway',
    );

    const back = planGatewaySwitch({
      providerKey: 'openrouter',
      supportsZeroDataRetention: true,
      tasks: ['script_generation'],
      routes: onMixRoute,
      candidates: new Map([
        ['script_generation', [model('google/gemini-3.5-flash-lite'), model('x/y')]],
      ]),
    });
    expect(back[0]?.target).toEqual(model('google/gemini-3.5-flash-lite'));
  });
});
