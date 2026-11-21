# UX Review Package — Content Studio, revision 1

- Status: **Revision 1, approved by the owner (2026-11-21)**: U1–U8 as recommended (U7: `lucide-react`;
  U8: English with a `t()` helper). Implementation notes in §10.
- Scope: every screen of `apps/web` (13 routes, 7 content-workspace tabs), desktop (1440 × 900),
  phone (iPhone 13, 390 px) and dark mode.
- Method: the E2E stack (mock providers, the data the E2E suite leaves behind: one exported item,
  one item at script review, two drafts) was signed in and screenshotted at every route and tab;
  phone layouts were measured for overflow and tap-target size; colour tokens were checked for
  WCAG 2.2 contrast. Owner input: the post-MVP review (Issues #01–#04) and the decisions of
  2026-11-21 (P3d → P3e → P4d → P2c → P1d).
- Visual prototype (private canvas, three artboards: workspace scenes board, phone, render):
  https://claude.ai/artifact/THPgAYv6MrEo6PJLZD3LBs
- Goal (owner): _better, modern, professional, smart and easy to use_. This package turns that into
  checkable changes and slices that fit the existing design system (`globals.css`, M4.5) instead
  of replacing it.

## 0. Summary

The visual base is sound: one token system, a dark mode that redefines tokens only, consistent
pills, cards and tables, no horizontal page scroll on phones, and no console errors on any screen.
What makes the studio feel hard to use is **structure, not style**:

1. A scene's work is split over three tabs (Keyframes, Clips, Voice-over), each listing one scene
   per full-width row. Five scenes already make a 2,750 px page; the 20-scene batches the owner
   expects would be about 11,000 px, and no screen answers "where is scene 3 right now?".
2. Progress is shown twice (the stepper at the top and the Production checklist on the right),
   while the next action is shown nowhere.
3. Small, low-contrast text and Unicode glyph icons make it look less finished than it is,
   especially on Windows, where the glyphs render differently.
4. On a phone the sidebar stays as a permanent icon rail, and the stepper and tabs are cut off
   without any sign that they scroll.

Plus **two defects** found during the review (§2): the Keyframes tab and the version history
show the wrong jobs, and the cost box counts voice-over costs twice.

## 1. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                                                 | Fixes           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| U1  | **Scene board.** One "Scenes" tab replaces Keyframes, Clips and Voice-over: one compact row per scene with three columns (keyframe, clip, voice-over), each showing the chosen item, its state and its next action; a row expands to the candidates and the stage details. This is also where P3e's compact monitor lives                              | F1, F2, F3, F11 |
| U2  | **One progress model, one next action.** Keep the stepper; replace the right-hand checklist with a _Next step_ card (what to do now, one primary button, what it costs) and a compact cost card. Model routing moves to the Activity tab                                                                                                               | F4, F5          |
| U3  | **Foundations.** Type scale with a 12 px minimum (13 px for body-small); `--muted` darkened to pass WCAG AA (4.5:1) and `--muted-2` kept for borders and disabled text only; SVG icons instead of Unicode glyphs; visible focus rings; dates in the user's locale with a 24-hour clock option                                                          | F6, F7, F8, F15 |
| U4  | **Phone shell.** Below 760 px: a top bar with a menu button opening the sidebar as a drawer, and a bottom bar with the 4 most used destinations; the stepper becomes "Step 3 of 6 · Storyboard" with a progress bar; tabs get edge fades and scroll the active tab into view; tap targets ≥ 40 px                                                      | F9, F10         |
| U5  | **Render tab in the order of the work.** Settings first (captions, audio layers including music), then _Render_; the duplicated music selector goes; downloads become one "Download package" button plus a file menu; QC findings are grouped (passed / warnings / errors) and the frozen-picture warnings collapse into one line                      | F12             |
| U6  | **Library and Operations.** Library: clips show their keyframe as a poster, audio shows a waveform strip, file types get human labels ("Subtitles (SRT)" instead of `application/x-subrip`), collections in a left rail (P2b data). Operations: a health strip first (worker, tools, providers, budget), queues collapsed when idle, human queue names | F13, F14        |
| U7  | **Icon set.** `lucide-react` (pinned exact version, ISC licence, tree-shaken SVG components) as the one new dependency; or, if no new dependency is wanted, a hand-maintained inline SVG sprite of about 30 icons                                                                                                                                      | F7              |
| U8  | **Language.** The interface stays English in this round; all strings move behind one `t()` helper so Vietnamese can be added later without touching components. (Vietnamese now would double the work of U1–U6.)                                                                                                                                       | owner question  |

**Out of scope:** a new component library or CSS framework (the existing tokens and classes stay),
a rebrand, real-time push (SSE), and any API change beyond what P3e/P4d/P2c/P1d already need.

## 2. Defects found during the review (fix first, independent of the redesign)

| #   | Defect                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                          | Fix                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| D1  | The image scene listing loads **every** job of the scene, not only image jobs, so `lastJob`/`activeJob` of a keyframe scene can be a clip or voice-over job. Seen: "Model routing → Images: mock/tone-tts" (the TTS model); version history lists "Scene 5 image job succeeded · mock/tone-tts"; the cost box adds voice-over costs twice and image costs never | `apps/api/src/generation/images.service.ts:296` (`where: { storyboardSceneId: { in: sceneIds } }`); clips and voice-overs filter by `kind` (`videos.service.ts:307`, `voiceovers.service.ts:267`) | Add `kind: 'image_generation'`; API integration test with mixed jobs   |
| D2  | Brief warnings show raw field paths: "brief.audience: not set; the model will choose"                                                                                                                                                                                                                                                                           | `packages/content-domain/src/brief.ts:135`, shown on the Script tab                                                                                                                               | Web maps `path` to a label ("Audience not set: the model will choose") |

## 3. Findings

Evidence screenshots were taken from the E2E stack on 2026-11-21 (not committed; reproduce with
the procedure in §8).

| #   | Screen                       | Finding                                                                                                                                                                                               | Severity |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F1  | Keyframes, Clips, Voice-over | One scene per full-width row with a single 130 px thumbnail; ~75 % of each row is empty. 5 scenes = 2,750 px on desktop, 10,700 px on a phone                                                         | High     |
| F2  | Content workspace            | A scene's state is spread over three tabs; checking one scene means three tab switches and three scrolls                                                                                              | High     |
| F3  | Clips, Voice-over            | Job state is one grey line ("Clip job succeeded"); a running, failed or waiting scene looks almost the same as a finished one. No elapsed time, no filter, failures not first (Issue #03)             | High     |
| F4  | Content workspace            | Progress appears twice (stepper + 7-line checklist); the checklist pushes cost and routing below the fold                                                                                             | Medium   |
| F5  | Content workspace            | Nothing says what to do next: on an exported item "Generate clips" is a disabled primary button with no reason; on a script in review the primary action sits at the bottom of a long card            | High     |
| F6  | Global                       | ~60 font sizes of 10–11 px; `.small-text` is 11 px                                                                                                                                                    | Medium   |
| F7  | Global                       | Navigation and stat icons are Unicode glyphs (◫ ▦ ▤ ◈ ⌘ ▧ ◉ ⚙). They render differently per OS and font (the owner works on Windows) and do not look like one set                                     | Medium   |
| F8  | Global                       | `--muted` (#7c8798) is 3.6:1 on white and 3.4:1 on the page background, used in 49 rules for meta text: fails WCAG AA for normal text. `--muted-2` is 2.3:1                                           | Medium   |
| F9  | Phone                        | The sidebar stays as a 78 px icon rail (20 % of the width) with "Sign out" wrapped; search shows "Searc"; the stepper shows 2 of 6 steps and the tabs 2.5 of 7 with no scroll hint                    | High     |
| F10 | Phone                        | 11 of 22 interactive elements on Overview are under 32 px tall                                                                                                                                        | Medium   |
| F11 | Storyboard                   | Scene cards are good, but the scene's references ("References (0)") and edit sit apart from the image prompt they affect; there is no product/reference preview on the card (Issue #02)               | Low      |
| F12 | Render & export              | _Render video_ comes before the collapsed Audio section, music is chosen in two places, downloads are five underlined links, and five identical "frozen picture" warnings fill the QC panel           | Medium   |
| F13 | Asset library                | Clips and audio show text placeholders ("▶ Clip · 6.0 s"); captions show the raw MIME type; collections are a filter only; two projects with the same name cannot be told apart in the project filter | Medium   |
| F14 | Operations                   | Starts with zero-filled queue tables using internal names (`generation-dlq`); the one dead-lettered job is a "1" in a column; budgets are plain links                                                 | Low      |
| F15 | Global                       | Absolute times use the browser's default locale and a 12-hour clock ("11/21/2026, 3:48:30 AM")                                                                                                        | Low      |
| F16 | Pipeline board               | 7 columns wrap at 1440 px, so "Approved" drops to a second row                                                                                                                                        | Low      |
| F17 | Activity                     | Jobs list and Version history repeat the same job events in two formats                                                                                                                               | Low      |

**What works well (keep):** the token system and dark mode; the stepper; status pills; the
storyboard card grid; Settings' sectioned layout (2026-11-21); confirmation and error texts from
P3 (W1–W3); empty states that explain what unlocks a stage.

## 4. Proposed design

### 4.1 Content workspace (U1, U2)

```
┌ Breadcrumb · Title · status pill ─────────────────────── [Version history] ┐
│ Stepper: Brief ✓ ─ Script ✓ ─ Storyboard ✓ ─ Scenes ◉ 3/5 ─ Render ○ ─ Export ○ │
├──────────────────────────────────────────────┬─────────────────────────────┤
│ Tabs: Script · Storyboard · Scenes 3/5 · Render · Activity                │ NEXT STEP                   │
│                                              │ Choose clips for 2 scenes   │
│ Scenes  [All 5][Needs you 2][Running 1][Failed 0]   [Generate ▾]          │ [Review scene 4 →]          │
│ ┌──┬──────────────┬────────────┬────────────┬──────────┐ │                             │
│ │# │ Keyframe     │ Clip       │ Voice-over │          │ │ COST (this item)            │
│ │01│ ▣ chosen     │ ▶ chosen   │ ♪ chosen   │ ✓ Done   │ │ $0.42 · 17 calls            │
│ │02│ ▣ chosen     │ ◉ 0:45     │ ♪ chosen   │ Running  │ │ Budget $3.10 of $10 left    │
│ │03│ ▣ chosen     │ ✕ check    │ ○          │ Fix ▸    │ └─────────────────────────────┘
│ │  │  ▼ Clip delivered · FFprobe missing · [Preview] [Finish – no new charge]    │
│ │04│ ▣ 3 to pick  │ ○ waiting  │ ○          │ Pick ▸   │
│ └──┴──────────────┴────────────┴────────────┴──────────┘
└──────────────────────────────────────────────┘
```

- **Scenes tab**: one row per scene (56 px collapsed, thumbnails 48 × 85 px in 9:16). Each
  cell shows the chosen item or the state (waiting, running with elapsed time, failed with a
  one-word reason, candidates to pick). Row status on the right: _Done_, _Running_, _Needs you_,
  _Failed_. Failed rows sort first; filters count each state. Clicking a cell opens the row: the
  candidates of that stage in a grid (4–6 per row), the stage details (P3e) and the actions
  (choose, regenerate, preview, finish). Only one row opens at a time.
- **Generate menu**: "Generate keyframes / clips / voice-overs for N scenes", each with its cost
  estimate inline, replacing three separate toolbars. Model and resolution move into the menu's
  "Options".
- **Next step card** (right column, sticky): computed from the content status and the scene
  board (e.g. "Approve the script", "Choose keyframes for 2 scenes", "Render the video"). One
  primary button that jumps to the right place. When nothing is needed: "Nothing to do: 2 jobs
  running" with elapsed time.
- **Cost card**: this item's spend (reported + estimated, with unknown calls called out), budget
  remaining. Model routing moves to Activity.
- **Storyboard**: each card shows its reference thumbnails (up to 3, "+2") under the image
  prompt, and the references button opens the picker (P2c adds upload there).

### 4.2 Foundations (U3, U7)

| Token / rule       | Today                       | Proposed                                                                                  |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| Type scale         | 10, 11, 12, 13, 14 … ad hoc | 12 (caption), 13 (small), 14 (body), 16 (lead), 20 / 24 / 30 (headings); 10–11 px removed |
| `--muted` (light)  | #7c8798 (3.6:1)             | #5f6b7d (≈ 5.3:1 on white, ≥ 4.5:1 on `--bg`)                                             |
| `--muted-2`        | text and borders            | borders, placeholders and disabled only                                                   |
| Icons              | Unicode glyphs              | `lucide-react` 16/20 px, stroke 1.75, `aria-hidden` (U7)                                  |
| Focus              | browser default in places   | 2 px `--accent` ring, 2 px offset, on every interactive element                           |
| Radius / elevation | 14 px cards, one shadow     | kept; one extra "raised" shadow for menus and the drawer                                  |
| Dates              | `toLocaleString()`          | `Intl.DateTimeFormat` with the user's locale, `hourCycle: 'h23'`, relative within 24 h    |
| Motion             | none                        | 150 ms ease-out for row expand, drawer, toast; off under `prefers-reduced-motion`         |

### 4.3 Phone shell (U4)

Top bar: menu button, page title, search icon. Drawer: the current sidebar unchanged. Bottom
bar (≤ 760 px): Overview, Pipeline, Library, Operations. Stepper collapses to one line with a
progress bar; tabs scroll with edge fades. Scene board rows stack the three cells vertically
under the scene number. All buttons ≥ 40 px tall.

### 4.4 Render & export (U5), Library and Operations (U6)

- Render: "1 · Settings" (captions, audio layers from P4, music in the audio section only),
  "2 · Render" (button with the estimate "free, ~40 s"), "3 · Review" (player left, QC grouped
  right: ✓ passed checks in one line, warnings grouped by type with scene list), "4 · Export"
  (one _Download package_ button, a menu for single files).
- Library: poster frames (the clip's keyframe, already linked by `asset_inputs` role
  `keyframe`), audio waveform strip rendered client-side from the file (no new endpoint),
  readable type labels, collections rail with counts; project filter shows the project slug when
  names repeat.
- Operations: health strip (worker last seen, FFmpeg/FFprobe — from P3d R6 —, providers,
  this month's spend), then "Needs attention" (failed jobs, dead letters, held reservations),
  then queues (collapsed when all zero), queue names as stages ("Clips", "Voice-overs",
  "Dead letters").

## 5. How it lines up with the agreed packages

| Package | UX dependency                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------- |
| P3d     | Preview / _Finish (no new charge)_ live in the scene row (U1); tools status in Operations (U6)     |
| P3e     | **Merged into U1**: the scene board _is_ the compact monitor (filters, failed first, elapsed time) |
| P4d     | The voice-over column and stepper hide when voice is off in the brief                              |
| P2c     | Picker upload into a collection; reference thumbnails on storyboard cards (U1)                     |
| P1d     | Model import/prices in Settings › Models, using U3 foundations                                     |

## 6. Acceptance

| Criterion                                                                 | Evidence                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A 20-scene item's Scenes tab fits in ≤ 1,600 px collapsed on desktop      | E2E with a 20-scene fixture; screenshot height check                           |
| Every scene's state for all three stages is visible without switching tab | E2E: assertions on the scene board row cells                                   |
| The next action is one click from the top of the workspace                | E2E per content status (script review, storyboard, scenes, render, exported)   |
| Text contrast ≥ 4.5:1 (normal) in light and dark                          | Unit test over the token pairs; axe-core run in E2E (dev dependency, pinned)   |
| No text under 12 px                                                       | Stylelint rule or a unit test over `globals.css`                               |
| Phone: no horizontal scroll, tap targets ≥ 40 px, nav reachable           | Playwright at 390 px: `scrollWidth`, bounding boxes, drawer open/close         |
| D1, D2 fixed                                                              | API integration (mixed jobs per scene), web unit test for brief warning labels |
| Nothing else changes                                                      | Existing E2E pass (selectors updated where tabs merge)                         |

## 7. Implementation plan

| Slice | Content                                          | Notes                                             |
| ----- | ------------------------------------------------ | ------------------------------------------------- |
| UX-0  | D1, D2                                           | Independent; can ship before approval of the rest |
| UX-1  | U3 foundations, U7 icons                         | CSS tokens, icon component; no layout change      |
| UX-2  | U4 phone shell                                   | Shell components only                             |
| UX-3  | U1 scene board + P3e, U2 next step and cost card | Largest; replaces three tab panels                |
| UX-4  | U5 render tab                                    | Together with P4d (voice off)                     |
| UX-5  | U6 library and operations                        | Together with P2c (picker upload)                 |

Order with the agreed packages: **P3d → UX-0 → UX-1 → UX-2 → UX-3 (with P3e) → UX-4 (with P4d)
→ UX-5 (with P2c) → P1d**. Each slice is reviewed with screenshots (desktop, phone, dark) before
the next.

## 8. Reproducing the screenshots

`pnpm infra:up`, `pnpm build`, `pnpm test:e2e` (leaves the `acf_test_e2e` database populated),
set a password for `owner@demo.acf.test` against that database with `pnpm user:set-password`,
start the E2E API, worker and web with the environment of `apps/web/playwright.config.ts`, then
visit every route at 1440 × 900 (light, dark) and iPhone 13.

## 9. Risks

- **Merging three tabs changes E2E selectors and muscle memory.** Mitigation: deep links
  `#keyframes`, `#clips`, `#voiceover` open the Scenes tab with that column focused.
- **New dependency (U7).** One pinned package; the sprite alternative avoids it.
- **Darker muted text** slightly changes the look; checked in both themes before merging.
- **Scope creep.** Each slice keeps the existing data flow and API; anything needing new
  endpoints belongs to the P-packages, not the UX slices.

## 10. Implementation notes

| Slice | Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-0  | D1, D2                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `images.service.ts` filters `kind: 'image_generation'` (API integration test with a clip job on the same scene); brief issues read "Audience not set: the model will choose."                                                                                                   |
| UX-1  | Type scale (no text under 12 px, 59 rules raised), `--muted` #5f6b7d; light status colours darkened so every pill passes 4.5:1 (`green` #136b4d, `amber` #8a5a10, `red` #b23a47, `gray` #5f6b7d, purple pill uses `--accent-hover`); `lucide-react` 1.70.0 (pinned; two weeks old at install) through one `Icon` component replacing every Unicode glyph icon; dates `Intl.DateTimeFormat` medium date, short 24-hour time; search shortcut shows Ctrl K except on Apple devices | Token contrast and minimum size are unit-tested (`design-tokens.test.ts`). `t()` (`lib/i18n.ts`) is used by the navigation and the phone shell; other components move to it when they are reworked                                                                              |
| UX-2  | Phone shell ≤ 760 px: drawer sidebar (menu button, backdrop, Escape, closes on navigation), bottom bar (Overview, Content, Library, Operations), one-line stepper with progress bar, tab row with edge fade and active tab scrolled into view, 44 px controls                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                               |
| UX-3  | Scenes tab replaces Keyframes / Clips / Voice-over: board (one row per scene, three stage cells, filters with counts, failed first, elapsed time ticking each second), stage tabs below reuse the existing panels; choosing a cell shows that scene only; scene cards of a stage in a responsive grid. Next step card and cost card replace the checklist; model routing moved to Activity                                                                                       | Deviation: the stage panels stay below the board (instead of opening inside the row) so the tested generate / review / choose controls are reused unchanged; `#keyframes`, `#clips`, `#voiceover` links still work. Board logic is pure and unit-tested (`scene-board.test.ts`) |

E2E: 19/19 pass (`pnpm test:e2e`). The studio spec clicked the first asset while the list was
still re-rendering after the "Renders" filter (flaky lineage step); it now waits for the filtered
list. Two consecutive full runs pass.

| UX-4 | Render tab as 1 Settings, 2 Render, 3 Review & export; QC warnings grouped per check | with P4d |
| UX-5 | Library clip posters, readable file types, project names disambiguated; Operations: failures first, queues named and collapsed when idle; picker upload (P2c) | Deviation: no audio waveform (an icon and the duration instead): it would need decoding every file in the browser |
