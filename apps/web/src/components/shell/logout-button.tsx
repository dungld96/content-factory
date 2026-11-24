'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { csrfToken, forgetCsrfToken } from '@/lib/csrf-client';

export function LogoutButton() {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      const token = await csrfToken();
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: token ? { 'x-csrf-token': token } : {},
      });
    } finally {
      // Whatever the outcome, the client drops its token and leaves the signed-in area.
      forgetCsrfToken();
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button type="button" className="signout" onClick={() => void logout()} disabled={busy}>
      {busy ? t('user.signingOut') : t('user.signOut')}
    </button>
  );
}
