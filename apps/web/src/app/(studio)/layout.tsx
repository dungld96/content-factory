import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import { Icon } from '@/components/icon';
import { AppShell } from '@/components/shell/app-shell';
import { SidebarNav } from '@/components/shell/sidebar-nav';
import { AccountMenu, ProjectSwitch, ThemeToggle } from '@/components/shell/sidebar-parts';
import { SidebarNavWithCounts, SidebarSpend } from '@/components/shell/sidebar-status';
import { Topbar } from '@/components/shell/topbar';
import { Toaster } from '@/components/toast';
import { initials } from '@/lib/format';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';
import { getTheme } from '@/lib/theme';

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

  const theme = await getTheme();
  return (
    <AppShell
      sidebar={
        <>
          <Link href="/" className="brand" aria-label={t('app.home')}>
            <span className="brand-mark" aria-hidden="true">
              <Icon name="generate" size={16} />
            </span>
            {t('app.brandName')}
          </Link>
          <ProjectSwitch
            projects={memberships.map((m) => ({ id: m.projectId, name: m.projectName }))}
          />
          <Suspense fallback={<SidebarNav />}>
            <SidebarNavWithCounts />
          </Suspense>
          <div className="side-foot">
            <Suspense fallback={null}>
              <SidebarSpend />
            </Suspense>
            <AccountMenu
              name={user.displayName}
              email={user.email}
              avatar={
                <span className="avatar" aria-hidden="true">
                  {initials(user.displayName)}
                </span>
              }
              theme={<ThemeToggle initial={theme} />}
            />
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
