'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

import { rememberCsrfToken } from '@/lib/csrf-client';

type State =
  { readonly kind: 'idle' | 'submitting' } | { readonly kind: 'error'; readonly message: string };

const MESSAGES: Readonly<Record<number, string>> = {
  401: 'The email or password is incorrect.',
  429: 'Too many attempts. Wait a minute and try again.',
};

export function LoginForm() {
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
        setState({ kind: 'error', message: MESSAGES[res.status] ?? 'Sign-in failed. Try again.' });
        return;
      }
      const body = (await res.json()) as { csrfToken: string };
      rememberCsrfToken(body.csrfToken);
      router.replace('/');
      router.refresh();
    } catch {
      setState({ kind: 'error', message: 'The server could not be reached.' });
    }
  }

  const submitting = state.kind === 'submitting';
  return (
    <form className="form" onSubmit={(e) => void onSubmit(e)} noValidate={false}>
      <label className="field">
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.kind === 'error' && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
