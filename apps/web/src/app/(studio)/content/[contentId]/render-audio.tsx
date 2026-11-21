'use client';

import type { RenderPlanDto } from '@acf/contracts';

import type { AudioState } from '@/lib/render-audio';

const nameOf = (a: RenderPlanDto['sfxOptions'][number]) =>
  a.originalFilename ?? a.label ?? a.id.slice(0, 8);

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Audio layers of a render (P4 design S1–S6): voice-over, clip audio, music fades and ducking,
 * per-scene voice offset and music mute, and sound effects from the Library. Collapsed by
 * default; at the defaults the render is today's mix.
 */
export function RenderAudioSection(props: {
  readonly plan: RenderPlanDto;
  readonly state: AudioState;
  readonly hasMusic: boolean;
  readonly onChange: (next: AudioState) => void;
  /** P4d: voice-over is off for the content item (Script & brief › Audio). */
  readonly voiceLocked?: boolean;
}) {
  const { plan, state } = props;
  const set = (patch: Partial<AudioState>) => {
    props.onChange({ ...state, ...patch });
  };
  const clipsWithAudio = plan.scenes.filter((s) => s.clipHasAudio).length;
  const sceneOf = (id: string) => state.scenes[id] ?? { voiceOffsetMs: 0, muteMusic: false };

  return (
    <details className="earlier-versions" aria-label="Audio settings">
      <summary>Audio</summary>
      <div className="image-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.voiceEnabled}
            disabled={props.voiceLocked}
            onChange={(e) => {
              set({ voiceEnabled: e.target.checked });
            }}
          />
          Voice-over (no voice-over: no captions)
          {props.voiceLocked ? ' · off for this content (Script & brief › Audio)' : ''}
        </label>
        <label className="field">
          Voice level (dB)
          <input
            type="number"
            min={-20}
            max={12}
            step={1}
            value={state.voiceGainDb}
            disabled={!state.voiceEnabled}
            onChange={(e) => {
              set({ voiceGainDb: num(e.target.value, 0) });
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={state.clipAudio}
            onChange={(e) => {
              set({ clipAudio: e.target.checked });
            }}
          />
          Clip audio
        </label>
        {state.clipAudio && (
          <label className="field">
            Clip level (dB)
            <input
              type="number"
              min={-40}
              max={6}
              step={1}
              value={state.clipGainDb}
              onChange={(e) => {
                set({ clipGainDb: num(e.target.value, 0) });
              }}
            />
          </label>
        )}
      </div>
      {clipsWithAudio > 0 && !state.clipAudio && (
        <p className="muted small-text" role="status">
          {clipsWithAudio} chosen clip(s) have their own audio, which was paid for. Turn on “Clip
          audio” to use it; otherwise it is left out of the render.
        </p>
      )}
      {props.hasMusic && (
        <div className="image-toolbar">
          <label className="field">
            Music fade-in (ms)
            <input
              type="number"
              min={0}
              max={10_000}
              step={100}
              value={state.fadeInMs}
              onChange={(e) => {
                set({ fadeInMs: num(e.target.value, 0) });
              }}
            />
          </label>
          <label className="field">
            Music fade-out (ms)
            <input
              type="number"
              min={0}
              max={10_000}
              step={100}
              value={state.fadeOutMs}
              onChange={(e) => {
                set({ fadeOutMs: num(e.target.value, 1500) });
              }}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.ducking}
              onChange={(e) => {
                set({ ducking: e.target.checked });
              }}
            />
            Lower the music under the voice
          </label>
        </div>
      )}

      <div className="table-wrap">
        <table className="table" aria-label="Audio per scene">
          <thead>
            <tr>
              <th scope="col">Scene</th>
              <th scope="col">Voice starts at (ms)</th>
              {props.hasMusic && <th scope="col">Mute music</th>}
            </tr>
          </thead>
          <tbody>
            {plan.scenes.map((s) => (
              <tr key={s.sceneId}>
                <td>
                  {s.sceneNumber} · {s.durationSeconds} s
                </td>
                <td>
                  <input
                    type="number"
                    aria-label={`Voice offset of scene ${String(s.sceneNumber)}`}
                    min={0}
                    max={Math.round(s.durationSeconds * 1000)}
                    step={100}
                    value={sceneOf(s.sceneId).voiceOffsetMs}
                    disabled={!state.voiceEnabled || !s.voiceover}
                    onChange={(e) => {
                      set({
                        scenes: {
                          ...state.scenes,
                          [s.sceneId]: {
                            ...sceneOf(s.sceneId),
                            voiceOffsetMs: Math.max(0, num(e.target.value, 0)),
                          },
                        },
                      });
                    }}
                  />
                </td>
                {props.hasMusic && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Mute music in scene ${String(s.sceneNumber)}`}
                      checked={sceneOf(s.sceneId).muteMusic}
                      onChange={(e) => {
                        set({
                          scenes: {
                            ...state.scenes,
                            [s.sceneId]: { ...sceneOf(s.sceneId), muteMusic: e.target.checked },
                          },
                        });
                      }}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>Sound effects</h4>
      {plan.sfxOptions.length === 0 ? (
        <p className="muted small-text">
          Upload a sound effect (with its licence note) in the Asset library and approve it to use
          it here.
        </p>
      ) : (
        <>
          <ul className="plain-list" aria-label="Sound effects">
            {state.sfx.map((x, i) => (
              <li key={`${x.assetId}-${String(i)}`} className="image-toolbar">
                <select
                  aria-label="Sound effect"
                  value={x.assetId}
                  onChange={(e) => {
                    set({
                      sfx: state.sfx.map((y, j) =>
                        j === i ? { ...y, assetId: e.target.value } : y,
                      ),
                    });
                  }}
                >
                  {plan.sfxOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {nameOf(a)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Scene"
                  value={x.sceneId}
                  onChange={(e) => {
                    set({
                      sfx: state.sfx.map((y, j) =>
                        j === i ? { ...y, sceneId: e.target.value } : y,
                      ),
                    });
                  }}
                >
                  {plan.scenes.map((s) => (
                    <option key={s.sceneId} value={s.sceneId}>
                      Scene {s.sceneNumber}
                    </option>
                  ))}
                </select>
                <label className="field">
                  At (ms)
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={x.offsetMs}
                    onChange={(e) => {
                      set({
                        sfx: state.sfx.map((y, j) =>
                          j === i ? { ...y, offsetMs: Math.max(0, num(e.target.value, 0)) } : y,
                        ),
                      });
                    }}
                  />
                </label>
                <label className="field">
                  Level (dB)
                  <input
                    type="number"
                    min={-40}
                    max={6}
                    step={1}
                    value={x.gainDb}
                    onChange={(e) => {
                      set({
                        sfx: state.sfx.map((y, j) =>
                          j === i ? { ...y, gainDb: num(e.target.value, 0) } : y,
                        ),
                      });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    set({ sfx: state.sfx.filter((_, j) => j !== i) });
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn small"
            disabled={state.sfx.length >= 20 || plan.scenes.length === 0}
            onClick={() => {
              const first = plan.sfxOptions[0];
              const scene = plan.scenes[0];
              if (first && scene) {
                set({
                  sfx: [
                    ...state.sfx,
                    { assetId: first.id, sceneId: scene.sceneId, offsetMs: 0, gainDb: 0 },
                  ],
                });
              }
            }}
          >
            Add a sound effect
          </button>
        </>
      )}
    </details>
  );
}
