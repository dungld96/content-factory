'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { useLocale, useT } from '@/components/i18n-provider';
import { mutate } from '@/lib/api-client';
import { LOCALE_COOKIE, LOCALES, type Locale } from '@/lib/i18n';

const ONE_YEAR_SECONDS = 365 * 86_400;

/** Remembers the language in a cookie so the next page renders in it straight away. */
export function rememberLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${String(ONE_YEAR_SECONDS)}; samesite=lax`;
}

/** Forgets the remembered language ("follow the browser"). */
export function forgetLocale(): void {
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/**
 * VI / EN switch (redesign R-D6). Signed in, the choice is saved on the user's profile so it
 * follows them to other devices; the page re-renders in the new language without a reload.
 */
export function LanguageSwitch(props: {
  readonly signedIn: boolean;
  readonly variant?: 'nav' | 'light';
}) {
  const t = useT();
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  async function choose(locale: Locale) {
    if (locale === current) return;
    rememberLocale(locale);
    if (props.signedIn) {
      setSaving(true);
      await mutate('PATCH', '/auth/me/preferences', { locale });
      setSaving(false);
    }
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div
      className={props.variant === 'light' ? 'lang-switch light' : 'lang-switch'}
      role="group"
      aria-label={t('user.languageSwitch')}
      aria-busy={pending || saving}
    >
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={locale === current}
          title={t(locale === 'vi' ? 'lang.vi' : 'lang.en')}
          disabled={pending || saving}
          onClick={() => void choose(locale)}
        >
          {t(locale === 'vi' ? 'lang.viShort' : 'lang.enShort')}
        </button>
      ))}
    </div>
  );
}
