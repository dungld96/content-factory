import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Icon } from '@/components/icon';
import { LanguageSwitch } from '@/components/language-switch';
import { getT } from '@/lib/i18n/server';
import { getMe } from '@/lib/me';

import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('login.pageTitle') };
}

export default async function LoginPage() {
  // Already signed in: go straight to the workspace.
  const me = await getMe();
  if (me.kind === 'ok') redirect('/');
  const t = await getT();

  return (
    <div className="standalone">
      <section className="card standalone-card">
        <div className="login-head">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="generate" size={18} />
            </span>
            <span className="brand-copy">
              <span className="brand-name">{t('app.brandName')}</span>
              <span className="brand-sub">{t('app.brandSub')}</span>
            </span>
          </div>
          <LanguageSwitch signedIn={false} variant="light" />
        </div>
        <h1>{t('login.title')}</h1>
        <p className="modal-desc">{t('login.hint')}</p>
        <LoginForm />
      </section>
    </div>
  );
}
