import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import type { MeResponse } from '@acf/contracts';

import { Icon } from '@/components/icon';
import { AppShell } from '@/components/shell/app-shell';
import { LogoutButton } from '@/components/shell/logout-button';
import { SidebarNav } from '@/components/shell/sidebar-nav';
import { Topbar } from '@/components/shell/topbar';
import { Toaster } from '@/components/toast';
import { apiGet } from '@/lib/api-server';
import { initials } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** The signed-in workspace shell (prototype sidebar + topbar). Signed-out visitors sign in. */
export default async function StudioLayout({ children }: { readonly children: ReactNode }) {
  const me = await apiGet<MeResponse>('/auth/me');
  if (me.kind === 'unauthenticated') redirect('/login');
  if (me.kind === 'error') {
    return (
      <div className="standalone">
        <section className="card standalone-card" role="alert">
          <h1>The workspace is unavailable</h1>
          <p className="muted">
            The API could not be reached{me.status ? ` (HTTP ${String(me.status)})` : ''}. Check{' '}
            <Link href="/status">system status</Link> and reload the page.
          </p>
        </section>
      </div>
    );
  }
  const { user, memberships } = me.data;
  const owned = memberships.filter((m) => m.role === 'owner').length;

  return (
    <AppShell
      sidebar={
        <>
          <Link href="/" className="brand" aria-label="Content Studio overview">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="generate" size={18} />
            </span>
            <span className="brand-copy">
              <span className="brand-name">content studio</span>
              <span className="brand-sub">AI content factory</span>
            </span>
          </Link>
          <div className="workspace-switch">
            <span className="workspace-icon" aria-hidden="true">
              W
            </span>
            <span className="workspace-copy">
              <b>My workspace</b>
              <span>
                {memberships.length} project{memberships.length === 1 ? '' : 's'} · {owned} owned
              </span>
            </span>
          </div>
          <SidebarNav projectCount={memberships.length} />
          <div className="sidebar-bottom">
            <div className="profile">
              <span className="avatar" aria-hidden="true">
                {initials(user.displayName)}
              </span>
              <span className="profile-copy">
                <b>{user.displayName}</b>
                <small>{user.email}</small>
              </span>
              <LogoutButton />
            </div>
          </div>
        </>
      }
    >
      <div className="main">
        {/* useSearchParams in the topbar needs a Suspense boundary. */}
        <Suspense fallback={<header className="topbar" />}>
          <Topbar />
        </Suspense>
        <main className="content">{children}</main>
      </div>
      <Toaster />
    </AppShell>
  );
}
