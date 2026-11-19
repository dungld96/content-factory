import type { Metadata } from 'next';
import { DM_Sans, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

// Self-hosted at build time by next/font: the browser never contacts Google.
const dmSans = DM_Sans({ subsets: ['latin', 'latin-ext'], variable: '--font-dm-sans' });
const manrope = Manrope({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  variable: '--font-manrope',
});

export const metadata: Metadata = {
  title: 'Content Studio · AI Content Factory',
  description: 'Brief-to-video production workspace',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${manrope.variable}`}>
      <body>{children}</body>
    </html>
  );
}
