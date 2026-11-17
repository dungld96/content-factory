import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'AI Content Factory',
  description: 'Brief-to-video production workspace',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav" aria-label="Main">
            <strong>AI Content Factory</strong>
            <Link href="/">Home</Link>
            <Link href="/status">System status</Link>
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
