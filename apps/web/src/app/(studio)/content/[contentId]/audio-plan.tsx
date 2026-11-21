'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(voiceEnabled: boolean) {
    setBusy(true);
    setError(null);
    const r = await mutate('PATCH', `/content/${props.contentId}`, { voiceEnabled });
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? 'The audio plan could not be saved.');
      return;
    }
    toast(
      voiceEnabled ? 'Voice-over is on.' : 'Voice-over is off: no voice-over will be generated.',
    );
    router.refresh();
  }

  return (
    <div className="audio-plan" aria-label="Audio plan">
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={props.voiceEnabled}
          disabled={!props.canEdit || busy}
          onChange={(e) => void change(e.target.checked)}
        />
        <span>
          <b>Voice-over</b>
          <small className="muted">
            {props.voiceEnabled
              ? 'A narrated voice-over is generated for each scene with text.'
              : 'Off: no voice-over jobs or cost; the video has no narration or captions.'}
          </small>
        </span>
      </label>
      <p className="muted small-text">Music and sound effects are chosen when rendering.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
