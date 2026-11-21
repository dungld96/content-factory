import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { basicJsonSchema, toResponseJsonSchema } from './json-schema.js';
import { narrationWordsPerSecond, renderPrompt, storyboardV2 } from './index.js';
import { storyboardContentSchema, storyboardRuleIssues } from './storyboard.js';
import { sampleScript, sampleStoryboard } from './testing/index.js';

describe('basicJsonSchema (M8.5 Q2)', () => {
  it('drops value constraints and keeps the structure, enums and property names', () => {
    const schema = toResponseJsonSchema(
      z.strictObject({
        id: z.uuid(),
        count: z.number().int().min(1).max(30),
        items: z.array(z.string().min(1).max(10)).min(1).max(5),
        kind: z.enum(['a', 'b']),
        format: z.string().max(3), // a property named like a keyword stays
      }),
    );
    const basic = basicJsonSchema(schema);
    const text = JSON.stringify(basic);
    for (const keyword of [
      'pattern',
      '"minimum"',
      '"maximum"',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ]) {
      expect(text).not.toContain(keyword);
    }
    expect(basic).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'count', 'items', 'kind', 'format'],
      properties: {
        id: { type: 'string' },
        count: { type: 'integer' },
        items: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string', enum: ['a', 'b'] },
        format: { type: 'string' },
      },
    });
    // The full storyboard schema shrinks but keeps every required field.
    const full = toResponseJsonSchema(storyboardContentSchema);
    expect(JSON.stringify(basicJsonSchema(full)).length).toBeLessThan(JSON.stringify(full).length);
  });
});

describe('scene lengths (M8.5 Q1)', () => {
  const ctx = {
    targetDurationSeconds: 30,
    allowedCharacterVersionIds: [],
    allowedEnvironmentVersionIds: [],
    allowedAssetIds: [],
  };
  const withDurations = (durations: number[]) => {
    const base = sampleStoryboard();
    const scene = base.scenes[0];
    if (!scene) throw new Error('fixture');
    return {
      scenes: durations.map((d, i) => ({
        ...scene,
        sceneNumber: i + 1,
        durationSeconds: d,
        characterVersionId: null,
        environmentVersionId: null,
        requiredReferenceAssetIds: [],
      })),
    };
  };

  it('accepts clip lengths only when the video model has them', () => {
    const content = withDurations([6, 8, 8, 8]);
    expect(storyboardRuleIssues(content, { ...ctx, allowedSceneDurations: [4, 6, 8] })).toEqual([]);
    const off = withDurations([5, 7, 8, 10]);
    const issues = storyboardRuleIssues(off, { ...ctx, allowedSceneDurations: [4, 6, 8] });
    expect(issues.map((i) => i.path)).toEqual([
      'scenes.0.durationSeconds',
      'scenes.1.durationSeconds',
      'scenes.3.durationSeconds',
    ]);
    expect(issues[0]?.message).toBe('5 s is not a clip length; use one of 4, 6, 8 s');
    // Without a video model (or before M8.5) any length is fine.
    expect(storyboardRuleIssues(off, ctx)).toEqual([]);
    expect(storyboardRuleIssues(off, { ...ctx, allowedSceneDurations: null })).toEqual([]);
  });

  it('tells the model the lengths and the narration budget', () => {
    const prompt = renderPrompt(storyboardV2, {
      language: 'vi',
      targetDurationSeconds: 30,
      toleranceSeconds: 1.5,
      aspectRatio: '9:16',
      script: sampleScript(),
      characters: [],
      environments: [],
      clipDurations: [4, 6, 8],
      wordsPerSecond: 2.7,
    });
    const system = prompt.messages[0]?.content ?? '';
    expect(system).toContain('exactly one of: 4, 6, 8');
    expect(system).toContain('about 2.7 words per second');
    expect(system).toContain('Scene durations must add up to 30 seconds');
    const noVideo = renderPrompt(storyboardV2, {
      language: 'vi',
      targetDurationSeconds: 30,
      toleranceSeconds: 1.5,
      aspectRatio: '9:16',
      script: sampleScript(),
      characters: [],
      environments: [],
      clipDurations: null,
      wordsPerSecond: 2.4,
    });
    expect(noVideo.messages[0]?.content).not.toContain('exactly one of');
  });

  it('paces narration by language and voice speed', () => {
    expect(narrationWordsPerSecond('vi-VN', 1)).toBe(2.7);
    expect(narrationWordsPerSecond('en', null)).toBe(2.4);
    expect(narrationWordsPerSecond('vi', 1.2)).toBe(3.24);
  });
});
