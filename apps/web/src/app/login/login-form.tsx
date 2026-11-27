'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

import { useT } from '@/components/i18n-provider';
import { rememberCsrfToken } from '@/lib/csrf-client';
import type { MessageKey } from '@/lib/i18n';

type State =
  { readonly kind: 'idle' | 'submitting' } | { readonly kind: 'error'; readonly message: string };

const MESSAGES: Readonly<Record<number, MessageKey>> = {
  401: 'login.invalid',
  429: 'login.rateLimited',
};

export function LoginForm() {
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState({ kind: 'submitting' });
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (!res.ok) {
        setState({ kind: 'error', message: t(MESSAGES[res.status] ?? 'login.failed') });
        return;
      }
      const body = (await res.json()) as { csrfToken: string };
      rememberCsrfToken(body.csrfToken);
      router.replace('/');
      router.refresh();
    } catch {
      setState({ kind: 'error', message: t('login.unreachable') });
    }
  }

  const submitting = state.kind === 'submitting';
  return (
    <form className="form" onSubmit={(e) => void onSubmit(e)} noValidate={false}>
      <label className="field">
        {t('login.email')}
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label className="field">
        {t('login.password')}
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.kind === 'error' && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={submitting}>
        {submitting ? t('login.submitting') : t('login.submit')}
      </button>
    </form>
  );
}
