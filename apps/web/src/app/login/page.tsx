import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import type { MeResponse } from '@acf/contracts';

import { apiGet } from '@/lib/api-server';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · AI Content Factory' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in: go straight to the projects.
  const me = await apiGet<MeResponse>('/auth/me');
  if (me.kind === 'ok') redirect('/projects');

  return (
    <>
      <h1>Sign in</h1>
      <p className="muted">Accounts are created by an administrator.</p>
      <LoginForm />
    </>
  );
}
