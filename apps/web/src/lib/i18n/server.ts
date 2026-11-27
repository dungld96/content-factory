import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { getMe } from '../me';
import { LOCALE_COOKIE, resolveLocale, translator, type Locale, type Translate } from './index';

/** The request's interface language (profile → cookie → Accept-Language → English). */
export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const cookie = cookieStore.get(LOCALE_COOKIE)?.value ?? null;
  // Shared with the layout's profile request (React cache): no extra API call.
  const me = await getMe();
  return resolveLocale({
    preference: me.kind === 'ok' ? me.data.locale : null,
    cookie,
    acceptLanguage: headerStore.get('accept-language'),
  });
});

export async function getT(): Promise<Translate> {
  return translator(await getLocale());
}
