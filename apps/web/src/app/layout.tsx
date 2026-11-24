import type { Metadata } from 'next';
import { Be_Vietnam_Pro, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import { I18nProvider } from '@/components/i18n-provider';
import { getLocale, getT } from '@/lib/i18n/server';

import './globals.css';
import './redesign.css';

// Self-hosted at build time by next/font: the browser never contacts Google. Be Vietnam Pro
// replaces DM Sans, which has no Vietnamese subset (redesign R-D6).
const beVietnam = Be_Vietnam_Pro({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-be-vietnam',
});
const manrope = Manrope({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  variable: '--font-manrope',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('app.title'), description: t('app.description') };
}

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${beVietnam.variable} ${manrope.variable}`}>
      {/* Browser extensions (e.g. ColorZilla's cz-shortcut-listen) add attributes to <body> before
          React hydrates; this silences that one-level attribute mismatch only, not the children. */}
      <body suppressHydrationWarning>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
