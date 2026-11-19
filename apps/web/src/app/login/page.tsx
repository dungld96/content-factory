import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type { MeResponse } from '@acf/contracts';

import { apiGet } from '@/lib/api-server';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · Content Studio' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in: go straight to the workspace.
  const me = await apiGet<MeResponse>('/auth/me');
  if (me.kind === 'ok') redirect('/');

  return (
    <div className="standalone">
      <section className="card standalone-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <span className="brand-copy">
            <span className="brand-name">content studio</span>
            <span className="brand-sub">AI content factory</span>
          </span>
        </div>
        <h1>Sign in</h1>
        <p className="modal-desc">Accounts are created by an administrator.</p>
        <LoginForm />
      </section>
    </div>
  );
}
