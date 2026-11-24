import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import { Icon } from '@/components/icon';
import { LanguageSwitch } from '@/components/language-switch';
import { AppShell } from '@/components/shell/app-shell';
import { LogoutButton } from '@/components/shell/logout-button';
import { SidebarNav } from '@/components/shell/sidebar-nav';
import { SidebarNavWithCounts, SidebarSpend } from '@/components/shell/sidebar-status';
import { Topbar } from '@/components/shell/topbar';
import { Toaster } from '@/components/toast';
import { initials } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';

export const dynamic = 'force-dynamic';

/** The signed-in workspace shell (sidebar + topbar). Signed-out visitors sign in. */
export default async function StudioLayout({ children }: { readonly children: ReactNode }) {
  const [me, t] = await Promise.all([getMe(), getT()]);
  if (me.kind === 'unauthenticated') redirect('/login');
  if (me.kind === 'error') {
    return (
      <div className="standalone">
        <section className="card standalone-card" role="alert">
          <h1>{t('app.unavailableTitle')}</h1>
          <p className="muted">
            {t('app.unavailableBody', {
              status: me.status ? ` (HTTP ${String(me.status)})` : '',
            })}{' '}
            <Link href="/status">{t('app.systemStatus')}</Link>
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
          <Link href="/" className="brand" aria-label={t('app.home')}>
            <span className="brand-mark" aria-hidden="true">
              <Icon name="generate" size={18} />
            </span>
            <span className="brand-copy">
              <span className="brand-name">{t('app.brandName')}</span>
              <span className="brand-sub">{t('app.brandSub')}</span>
            </span>
          </Link>
          <div className="workspace-switch">
            <span className="workspace-icon" aria-hidden="true">
              W
            </span>
            <span className="workspace-copy">
              <b>{t('nav.myWorkspace')}</b>
              <span>
                {t('nav.workspaceSummary', { count: memberships.length })} ·{' '}
                {t('nav.ownedSummary', { count: owned })}
              </span>
            </span>
          </div>
          <Suspense fallback={<SidebarNav />}>
            <SidebarNavWithCounts />
          </Suspense>
          <div className="sidebar-bottom">
            <Suspense fallback={null}>
              <SidebarSpend />
            </Suspense>
            <div className="profile">
              <span className="avatar" aria-hidden="true">
                {initials(user.displayName)}
              </span>
              <span className="profile-copy">
                <b>{user.displayName}</b>
                <small>{user.email}</small>
              </span>
            </div>
            <div className="profile-tools">
              <LanguageSwitch signedIn />
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
