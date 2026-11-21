# P4 Design Review Package — Audio Configuration

- Status: **Revision 1, approved by the owner (2026-11-21)** by standing instruction ("follow your
  recommendations until all packages are complete"): S1–S7 as proposed; clip audio as a render
  layer (owner decision, 2026-11-20). Slices P4a–P4c implemented (§9); API integration and E2E
  verification pending.
- Date: 2026-11-21
- Baseline: P2a/P2b implemented (Library approval, immutable `purpose`, picker). Input:
  `docs/post-mvp/POST_MVP_AUDIT.md` §A4, §B4, §C4.

P4 turns the render's audio into configurable layers without changing TTS, the voice-over flow
or the loudness target. The default stays exactly today's render.

## 0. Decisions

| ID  | Decision                                                                                                                                                                                                                                                               | Section |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| S1  | **Layers**: voice-over (on/off, gain), music (existing track and level, plus fade-in, fade-out, ducking on/off, mute per scene), clip audio (on/off, gain), sound effects (Library audio placed in a scene at an offset, with gain)                                    | §2      |
| S2  | **Recorded in the manifest**: an optional `audio` block in `renderManifestSchema`; its presence selects renderer `render.v2`. A render requested without `audio` has exactly today's manifest and settings (`render.v1`), so its execution key and reuse are unchanged | §3      |
| S3  | **SFX are Library uploads** with `purpose: sfx` and a licence note (like music), approved before use; `asset_inputs` gains role `sfx` (migration: CHECK only)                                                                                                          | §4      |
| S4  | **Voice timing**: a per-scene voice offset (ms); offset + voice-over must fit the scene (otherwise `VOICEOVER_EXCEEDS_SCENE`, as today)                                                                                                                                | §2      |
| S5  | **Voice-over off**: the render no longer needs a voice-over for scenes with narration (`VOICEOVERS_INCOMPLETE` is not raised); captions follow the voice-overs, so a render without voice has no captions                                                              | §5      |
| S6  | **Clip audio is usable**: the render plan reports which chosen clips have an audio stream and warns when they would be dropped                                                                                                                                         | §5      |
| S7  | **Cost**: mixing stays free; TTS estimates and budgets are unchanged; the plan shows that clip audio was paid for when it is not used                                                                                                                                  | §5      |

**Out of scope:** an SFX library, automatic ducking curves per scene, speech-aligned timing,
audio-only exports, changing the −14 LUFS target.

## 1. Acceptance

| Criterion                                                            | Evidence                                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A render without `audio` is unchanged                                | Unit: `renderSettings(burnIn)` and the manifest equal today's for the same inputs; execution key unchanged; existing render tests pass |
| Every audio setting is in the manifest and changes the execution key | Unit: execution key differs per setting                                                                                                |
| The mix is right and passes QC                                       | Media tests: each layer present/absent (FFprobe audio stream, loudness within target); `pnpm media:selftest` with SFX and clip audio   |
| SFX must be approved project uploads with a licence note             | API integration: `422 SFX_INVALID` otherwise; upload `purpose=sfx` without licence note → `422`                                        |
| Voice off renders without voice-overs                                | API integration: plan without `VOICEOVERS_INCOMPLETE` when `audio.voice.enabled = false`                                               |
| Lineage records SFX                                                  | Worker: `asset_inputs` role `sfx` for each effect                                                                                      |

## 2. Layers (S1, S4)

`createRenderRequestSchema` gains an optional `audio`:

```text
audio: {
  voice?:     { enabled?: boolean = true, gainDb?: -20..12 = 0 }
  music?:     { fadeInMs?: 0..10000 = 0, fadeOutMs?: 0..10000 = 1500, ducking?: boolean = true }
  clipAudio?: { enabled: boolean, gainDb?: -40..6 = 0 }
  sfx?:       [{ assetId, sceneId, offsetMs: ≥ 0, gainDb?: -40..6 = 0 }]   (≤ 20)
  scenes?:    [{ sceneId, voiceOffsetMs?: ≥ 0 = 0, muteMusic?: boolean = false }]
}
```

The music track itself stays in `music: { assetId, volumeDb }` (unchanged).

## 3. Manifest and renderer (S2)

- `renderManifestSchema.audio` (optional): the resolved values above, with SFX resolved to
  `{ assetId, sceneNumber, startMs (absolute), gainDb, licenseNote }` and per-scene values keyed by
  scene number; scenes gain optional `clipHasAudio` and `voiceOffsetMs`.
- `renderSettingsSchema.renderer`: `render.v1` | `render.v2`; `renderSettings(burnIn, mixed)` uses
  `render.v2` only when `audio` is present.
- `packages/media/src/render.ts`: `RenderRequest.audio` (optional). Without it the FFmpeg graph is
  today's, string for string. With it: voice offset (`adelay`) and gain, clip audio extracted per
  scene (silence for clips without audio), music fades, ducking switch, per-scene mute
  (`volume=0:enable='between(t,a,b)'`), SFX (`adelay`, gain), one `amix`, then the same two-pass
  loudness. All paths still go through `filterPath`.

## 4. SFX (S3)

- Upload: `purpose` gains `sfx`; like music it needs a licence note (`422 LICENSE_NOTE_REQUIRED`).
- Render: each SFX must be an approved, active `audio` upload of the project with
  `purpose: sfx`, its scene in the approved storyboard, and `offsetMs` inside the scene
  (`422 SFX_INVALID` otherwise). Library filter `purpose=sfx`.
- Migration `p4_sfx_inputs`: `asset_inputs_role_known` adds `sfx`.

## 5. Plan, voice off, clip audio, cost (S5–S7)

- `GET /content/:id/render-plan` adds `sfxOptions` (approved SFX uploads) and per scene
  `clipHasAudio` (from the clip's probe metadata, `metadata.video.hasAudio`).
- With `audio.voice.enabled = false`, the create request skips the voice-over blockers; the
  manifest scenes carry no voice-over.
- Web: an **Audio** section in the render panel — voice (on/off, gain), clip audio (on/off, gain,
  with "N clips have their own audio" when any does), music fades and ducking, per-scene voice
  offset and music mute (collapsed table), SFX list (picker over `purpose=sfx`, scene, offset,
  gain). Leaving everything at its default sends no `audio`.

## 6. Tests

| Level           | Tests                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit            | Manifest/settings parse v1 and v2; defaults produce v1; execution key per setting; request → manifest resolution (SFX absolute start, offsets) |
| Media           | Filter graph per layer (string tests); real renders with SFX and clip audio pass QC                                                            |
| Database        | `asset_inputs` accepts `sfx`                                                                                                                   |
| API integration | SFX validation; voice off; upload purpose `sfx`                                                                                                |

## 7. Implementation plan

| Slice | Content                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------- |
| P4a   | Domain (manifest/settings v2), media mix, self-test, unit and media tests                           |
| P4b   | API (request, plan, SFX validation, voice off, upload purpose), worker (inputs, lineage), migration |
| P4c   | Render panel Audio section; docs                                                                    |

## 8. Risks

- **FFmpeg 5.1 in the image**: `adelay=…:all=1` and `volume` with `enable` exist in 5.1; run
  `pnpm media:selftest` in the image after deploy.
- **Loudness with many layers**: normalisation runs on the final mix, so the target holds; QC
  checks it.
- **Captions with voice off**: none, by design (captions come from the voice-over text).

## 9. Deviations and results found during implementation

| Item                           | Planned                     | Done                                                                                                | Why                                                                                              |
| ------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `clipHasAudio` in the manifest | Always                      | Only in `render.v2` manifests                                                                       | Adding it to every manifest would change the execution key of plain renders and stop their reuse |
| Voice offset                   | Manifest scene field        | `manifest.audio.scenes[].voiceOffsetMs`                                                             | Keeps M6 scene records unchanged                                                                 |
| Render panel blockers          | From the plan               | The panel hides voice-over blockers when the voice layer is off; the API re-checks with the request | The plan endpoint has no request                                                                 |
| Render job template ID         | `RENDERER_VERSION` constant | The renderer actually used (`render.v1` / `render.v2`)                                              | Traceability                                                                                     |
| Self-test                      | One render                  | Two renders: the M6 mix and a layered `render.v2` mix                                               | Checks the new filters on the deploy image's FFmpeg                                              |
| E2E                            | Render panel audio          | **Not written**                                                                                     | Follow-up with the full stack                                                                    |

Verification: lint, typecheck, format, build and unit tests pass, including the media tests that
render with the real FFmpeg (layered mix within −14 ± 1 LUFS, voice offset in captions) and the
self-test with a layered render; database integration **run** (302 passed, `sfx` role); API
integration tests (audio layers, SFX validation, voice off) written, **not run** (the API suite
needs S3 storage in the implementation session).
