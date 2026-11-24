'use client';

import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, useTransition } from 'react';

import { useLocale, useT } from '@/components/i18n-provider';
import { forgetLocale, rememberLocale } from '@/components/language-switch';
import { toast } from '@/components/toast';
import { errorText, mutate } from '@/lib/api-client';
import { intlLocale, type Locale } from '@/lib/i18n';
import { formatUsd } from '@/lib/money';

const noSubscription = () => () => undefined;

/**
 * Profile & language (redesign R-D6): the interface language saved on the account (or "follow
 * the browser"), and a preview of how dates and numbers look in it.
 */
export function ProfileLanguage(props: { readonly saved: Locale | null }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(props.saved ?? '');
  const [error, setError] = useState<string | null>(null);
  const zone = useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => 'UTC',
  );

  async function save(next: string) {
    setValue(next);
    setError(null);
    const choice: Locale | null = next === 'en' || next === 'vi' ? next : null;
    const r = await mutate('PATCH', '/auth/me/preferences', { locale: choice });
    if (!r.ok) {
      setError(errorText(r));
      return;
    }
    if (choice) rememberLocale(choice);
    else forgetLocale();
    toast(t('set.languageSaved'));
    startTransition(() => {
      router.refresh();
    });
  }

  const sample = new Date(Date.UTC(2026, 10, 23, 14, 52));
  return (
    <div className="settings-columns">
      <section className="card card-pad" aria-labelledby="language">
        <div className="section-head">
          <div>
            <h3 id="language">{t('set.language')}</h3>
            <p>{t('set.languageHint')}</p>
          </div>
        </div>
        <fieldset className="radio-list" aria-busy={pending}>
          <legend className="sr-only">{t('set.language')}</legend>
          {(
            [
              ['vi', t('lang.vi')],
              ['en', t('lang.en')],
              ['', t('set.followBrowser')],
            ] as const
          ).map(([v, label]) => (
            <label key={v || 'browser'} className="radio">
              <input
                type="radio"
                name="locale"
                value={v}
                checked={value === v}
                disabled={pending}
                onChange={() => void save(v)}
              />
              <span lang={v || undefined}>{label}</span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="card card-pad" aria-labelledby="formats">
        <div className="section-head">
          <div>
            <h3 id="formats">{t('set.formats')}</h3>
            <p>{t('set.formatsHint', { zone })}</p>
          </div>
        </div>
        <dl className="kv">
          <dt>{t('set.previewDate')}</dt>
          <dd>
            {new Intl.DateTimeFormat(intlLocale(locale), {
              dateStyle: 'medium',
              timeStyle: 'short',
              hourCycle: 'h23',
              timeZone: zone,
            }).format(sample)}
          </dd>
          <dt>{t('set.previewNumber')}</dt>
          <dd>{new Intl.NumberFormat(intlLocale(locale)).format(12345.6)}</dd>
          <dt>{t('set.previewMoney')}</dt>
          <dd>{formatUsd('48.2')}</dd>
        </dl>
      </section>
    </div>
  );
}
