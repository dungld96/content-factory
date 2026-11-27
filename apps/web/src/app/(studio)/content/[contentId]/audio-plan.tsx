'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useT } from '@/components/i18n-provider';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';

/**
 * The content item's audio plan (P4d): voice-over on or off, chosen with the brief, before the
 * voice-over stage. Off: no voice-over jobs or cost, and renders without voice (and captions).
 * Music and sound effects are chosen when rendering.
 */
export function AudioPlan(props: {
  readonly contentId: string;
  readonly voiceEnabled: boolean;
  readonly canEdit: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(voiceEnabled: boolean) {
    setBusy(true);
    setError(null);
    const r = await mutate('PATCH', `/content/${props.contentId}`, { voiceEnabled });
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? t('ap.failed'));
      return;
    }
    toast(voiceEnabled ? t('ap.on') : t('ap.off'));
    router.refresh();
  }

  return (
    <div className="audio-plan" aria-label={t('ap.label')}>
      <label className="check-switch">
        <input
          type="checkbox"
          role="switch"
          checked={props.voiceEnabled}
          disabled={!props.canEdit || busy}
          onChange={(e) => void change(e.target.checked)}
        />
        <span>
          <b>{t('ap.voice')}</b>
          <small className="muted">{props.voiceEnabled ? t('ap.onHint') : t('ap.offHint')}</small>
        </span>
      </label>
      <p className="muted small-text">{t('ap.music')}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
