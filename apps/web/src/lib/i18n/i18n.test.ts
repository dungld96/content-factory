import { describe, expect, it } from 'vitest';

import { EN } from './en';
import { format, messagesFor, resolveLocale, translator } from './index';
import { VI } from './vi';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries (R-D6)', () => {
  it('Vietnamese has exactly the English keys', () => {
    expect(Object.keys(VI).sort()).toEqual(Object.keys(EN).sort());
  });

  it.each(Object.keys(EN) as (keyof typeof EN)[])('%s keeps the placeholders', (key) => {
    // Vietnamese has no plural form: compare the set of names, not their count.
    expect([...new Set(placeholders(VI[key]))]).toEqual([...new Set(placeholders(EN[key]))]);
    expect(VI[key].trim()).not.toBe('');
  });
});

describe('format', () => {
  it('fills placeholders and leaves unknown ones', () => {
    expect(format('en', 'Hi {name}, {x}', { name: 'An' })).toBe('Hi An, {x}');
  });

  it('chooses the plural form by count', () => {
    expect(format('en', '{count} project|{count} projects', { count: 1 })).toBe('1 project');
    expect(format('en', '{count} project|{count} projects', { count: 3 })).toBe('3 projects');
    expect(format('vi', '{count} dự án', { count: 3 })).toBe('3 dự án');
  });

  it('translates through the active dictionary', () => {
    expect(translator('vi')('nav.todo')).toBe('Việc cần làm');
    expect(translator('en')('nav.todo')).toBe('To-do');
    expect(messagesFor('vi')['nav.costs']).toBe('Chi phí');
  });
});

describe('resolveLocale', () => {
  it('prefers the saved choice, then the cookie, then Accept-Language', () => {
    expect(resolveLocale({ preference: 'vi', cookie: 'en' })).toBe('vi');
    expect(resolveLocale({ preference: null, cookie: 'vi' })).toBe('vi');
    expect(resolveLocale({ acceptLanguage: 'fr-FR,vi;q=0.8,en;q=0.5' })).toBe('vi');
    expect(resolveLocale({ acceptLanguage: 'en-US,vi;q=0.9' })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'de' })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });
});
