import { EN } from './en';
import { VI } from './vi';

/**
 * Interface strings (redesign R-D6): English and Vietnamese with the same keys. Pure module,
 * usable from server and client components; the active locale comes from `getT()` (server) or
 * `useT()` (client). Placeholders: `{name}`. A text with `|` has a singular and a plural form,
 * chosen by the `count` variable with the locale's plural rules ("{count} project|{count} projects").
 */
export const LOCALES = ['en', 'vi'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
/** Cookie holding the last chosen locale, so pages render in it before the profile is read. */
export const LOCALE_COOKIE = 'acf_locale';

export type MessageKey = keyof typeof EN;
export type Messages = Readonly<Record<MessageKey, string>>;
export type MessageVars = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, vars?: MessageVars) => string;

const DICTIONARIES: Readonly<Record<Locale, Messages>> = { en: EN, vi: VI };

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

/** Fills `{placeholders}` and picks the plural form for `count`. */
export function format(locale: Locale, text: string, vars: MessageVars = {}): string {
  let chosen = text;
  if (text.includes('|') && typeof vars['count'] === 'number') {
    const [one = '', other = one] = text.split('|');
    chosen = new Intl.PluralRules(locale).select(vars['count']) === 'one' ? one : other;
  }
  return chosen.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function translator(locale: Locale, messages: Messages = messagesFor(locale)): Translate {
  return (key, vars) => format(locale, messages[key] ?? EN[key], vars);
}

/**
 * The interface language: the user's saved choice, else the cookie, else the first supported
 * language of `Accept-Language`, else English.
 */
export function resolveLocale(input: {
  readonly preference?: string | null;
  readonly cookie?: string | null;
  readonly acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.preference)) return input.preference;
  if (isLocale(input.cookie)) return input.cookie;
  const ranked = (input.acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { lang: tag.trim().toLowerCase().split('-')[0] ?? '', q: q ? Number(q.split('=')[1]) : 1 };
    })
    .filter((entry) => entry.lang && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q);
  return ranked.map((entry) => entry.lang).find(isLocale) ?? DEFAULT_LOCALE;
}

/** BCP 47 tag for `Intl` (dates, numbers). */
export const intlLocale = (locale: Locale): string => (locale === 'vi' ? 'vi-VN' : 'en-GB');
