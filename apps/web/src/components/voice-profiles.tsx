'use client';

import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

import type { VoiceProfileDto } from '@acf/contracts';

import { Pill } from '@/components/status-pill';
import { toast } from '@/components/toast';
import { mutate } from '@/lib/api-client';

export interface TtsModelOption {
  readonly modelKey: string;
  readonly label: string;
  readonly enabled: boolean;
  /** The provider's voice ids (empty: the catalog lists none; any id is sent as typed). */
  readonly voices: readonly string[];
}

/**
 * Voices of `model` that match the typed language (`vi` matches `vi-VN-…`), all voices when none
 * match. Provider ids such as `vi-VN-Harper:MAI-Voice-2.1` start with the locale.
 */
export function voicesFor(model: TtsModelOption | undefined, language: string): string[] {
  if (!model) return [];
  const lang = language.trim().toLowerCase();
  const matching = lang ? model.voices.filter((v) => v.toLowerCase().startsWith(lang)) : [];
  return [...(matching.length > 0 ? matching : model.voices)];
}

/**
 * Project voice profiles (M5 design §7.1): the TTS model, provider voice, language and speed used
 * for voice-overs. Jobs snapshot them, so editing or archiving never changes past voice-overs.
 */
export function VoiceProfilesCard(props: {
  readonly projectId: string;
  readonly profiles: readonly VoiceProfileDto[];
  readonly models: readonly TtsModelOption[];
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only enabled models can synthesize (M8.5 Q5); the first one is preselected.
  const usable = props.models.filter((m) => m.enabled);
  const [modelKey, setModelKey] = useState(usable[0]?.modelKey ?? '');
  const [language, setLanguage] = useState('vi');
  const voiceOptions = voicesFor(
    usable.find((m) => m.modelKey === modelKey),
    language,
  );

  async function call(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const r = await mutate(method, path, body);
    setBusy(false);
    if (!r.ok) setError(r.message ?? `Request failed (HTTP ${String(r.status)})`);
    return r.ok;
  }

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = (key: string) => {
      const v = form.get(key);
      return typeof v === 'string' ? v.trim() : '';
    };
    const speed = text('speed');
    const instructions = text('instructions');
    const ok = await call('POST', `/projects/${props.projectId}/voice-profiles`, {
      name: text('name'),
      modelKey: text('modelKey'),
      voice: text('voice'),
      language: text('language'),
      ...(speed ? { speed: Number(speed) } : {}),
      ...(instructions ? { instructions } : {}),
    });
    if (ok) {
      formElement.reset();
      toast('Voice profile created.');
      router.refresh();
    }
  }

  async function archive(profile: VoiceProfileDto) {
    if (await call('POST', `/voice-profiles/${profile.id}/archive`)) {
      toast(`Archived ${profile.name}.`);
      router.refresh();
    }
  }

  return (
    <>
      {props.profiles.length === 0 ? (
        <p className="muted small-text">No voice profiles yet.</p>
      ) : (
        <ul className="plain-list" aria-label="Voice profiles">
          {props.profiles.map((p) => (
            <li key={p.id} className="audio-row" aria-label={p.name}>
              <span className="audio-meta">
                <b>{p.name}</b>
                <span>
                  {p.modelKey} · {p.voice} · {p.language}
                  {p.speed !== null ? ` · ${String(p.speed)}×` : ''}
                </span>
              </span>
              <span />
              {props.canEdit && (
                <span className="audio-actions">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void archive(p)}
                  >
                    Archive
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.canEdit &&
        (usable.length === 0 ? (
          <p className="muted small-text">
            No text-to-speech model is enabled. An operator imports and enables one first.
          </p>
        ) : (
          <form
            className="form"
            aria-label="New voice profile"
            onSubmit={(e) => void create(e)}
            style={{ marginTop: 14 }}
          >
            <label className="field">
              Name
              <input name="name" required maxLength={120} placeholder="Narrator (female, warm)" />
            </label>
            <label className="field">
              Model
              <select
                name="modelKey"
                required
                value={modelKey}
                onChange={(e) => {
                  setModelKey(e.target.value);
                }}
              >
                {usable.map((m) => (
                  <option key={m.modelKey} value={m.modelKey}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Language <small>(e.g. vi or vi-VN)</small>
              <input
                name="language"
                required
                maxLength={35}
                pattern="[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*"
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                }}
              />
            </label>
            <label className="field">
              Voice{' '}
              <small>
                {voiceOptions.length > 0
                  ? `(${String(voiceOptions.length)} voices for this language; type to search)`
                  : '(the provider’s voice id)'}
              </small>
              <input
                name="voice"
                required
                maxLength={200}
                list={voiceOptions.length > 0 ? 'voice-options' : undefined}
                autoComplete="off"
              />
              {voiceOptions.length > 0 && (
                <datalist id="voice-options">
                  {voiceOptions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              )}
            </label>
            <label className="field">
              Speed <small>(optional, 0.5–2)</small>
              <input name="speed" type="number" min={0.5} max={2} step={0.05} />
            </label>
            <label className="field">
              Instructions <small>(optional style prompt)</small>
              <input name="instructions" maxLength={500} />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Saving…' : 'Create voice profile'}
              </button>
            </div>
          </form>
        ))}
      {!props.canEdit && <Pill tone="gray">Read only</Pill>}
    </>
  );
}
