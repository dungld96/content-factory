import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';


// UX review U3: readable text sizes and contrast, checked on the stylesheet itself.
const css = readFileSync(path.join(import.meta.dirname, '../app/globals.css'), 'utf8');

function token(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block);
  if (!match?.[1]) throw new Error(`token --${name} not found`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const light = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const dark = css.slice(darkStart, css.indexOf('}\n}', darkStart));

describe('design tokens (UX review U3)', () => {
  it('has no text smaller than 12 px', () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.filter((s) => s < 12)).toEqual([]);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('meets WCAG AA (4.5:1) for text tokens in %s mode', (_, block) => {
    for (const fg of ['text', 'text-2', 'text-3', 'muted']) {
      for (const bg of ['surface', 'bg']) {
        expect(
          contrast(token(block, fg), token(block, bg)),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('status pills (UX review U3)', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ])('meet WCAG AA in %s mode', (_, block) => {
    for (const [fg, bg] of [
      ['green', 'green-soft'],
      ['amber', 'amber-soft'],
      ['red', 'red-soft'],
      ['gray', 'gray-soft'],
      ['accent-hover', 'accent-soft'],
      // Redesign Studio 2: information and review tones.
      ['info', 'info-soft'],
      ['review', 'review-soft'],
    ] as const) {
      expect(contrast(token(block, fg), token(block, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
