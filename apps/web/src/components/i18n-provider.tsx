'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { DEFAULT_LOCALE, translator, type Locale, type Translate } from '@/lib/i18n';

interface I18nValue {
  readonly locale: Locale;
  readonly t: Translate;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: translator(DEFAULT_LOCALE),
});

/** Gives client components the request's language (set by the root layout). */
export function I18nProvider(props: { readonly locale: Locale; readonly children: ReactNode }) {
  const { locale } = props;
  const value = useMemo(() => ({ locale, t: translator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
