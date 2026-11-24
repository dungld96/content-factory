# Redesign Package R — Content Studio structure, live jobs and bilingual UI, revision 1

- Status: **Revision 1, approved by the owner (2026-11-23)**: R-D1–R-D6 as recorded in §1. The
  owner asked to implement every slice in order until done ("làm tới khi xong toàn bộ").
  **Implemented 2026-11-24** (§10).
- Visual design (canvas, 25 artboards, pages 1–5): https://claude.ai/artifact/FrE8554N1wPbduxMke3sLE
- Builds on: `UX-review-package.md` (U1–U8, 2026-11-21). U8 ("English, all strings behind `t()`")
  is superseded by R-D6 (bilingual).
- Scope: `apps/web` (all routes), plus three small API/DB additions (§5): user locale, the
  cost-confirmation threshold, and the live job event stream.

## 0. Summary

The U1–U8 round fixed the visual base. What still makes the studio hard to drive is
**structure**: eight overlapping menu entries, a home page that does not say what needs the
operator, two progress vocabularies in the workspace, the next step pushed below the fold on
narrow screens, approval gates that are only buttons at the bottom of long cards, status shown
by colour alone, no global view of running jobs (each screen polls on its own), cost shown only
after an extra "Estimate" click, and a 423-line Settings page. Strings are hard-coded English, so
Vietnamese cannot be added.

## 1. Owner decisions (2026-11-23)

| ID   | Decision                                                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-D1 | **Menu of 7 task-based entries**: To-do, Productions (list / board), Projects (Brand, Masters, Costs as project tabs), Library, Costs, Operations, Settings.                                                                                                                                       |
| R-D2 | The home queue is called **To-do / Việc cần làm** (not "Inbox", which reads like a message box). Icon `list-checks`. Short phone label "Cần làm".                                                                                                                                                  |
| R-D3 | **Approval checklist is a reviewer aid, not persisted**: items with an automatic check that passed are pre-ticked, "Check all" (`C`), `Space` ticks the focused item; ticks kept in `localStorage` per artifact version. The decision and note go to the approval history as today. No API change. |
| R-D4 | **Cost-confirmation threshold, configurable**: default $1.00 for the workspace, optional override per project. Below the threshold (and no unknown price) a paid action runs in one click; above it, or with any unknown price, a dialog asks. Unknown cost always asks.                           |
| R-D5 | **Live jobs, optimised for performance**: one Server-Sent Events connection per browser (leader tab + `BroadcastChannel`), small deltas after the PostgreSQL commit, resume by `Last-Event-ID`, fallback to adaptive polling with ETag/304. One client store; no per-component polling loops.      |
| R-D6 | **Bilingual Vietnamese + English**, chosen per user (default from the browser), switchable in Settings › Profile and in the user menu. All UI strings via keys; locale-aware number/money/date formatting. Body font Be Vietnam Pro (DM Sans has no Vietnamese subset).                            |

## 2. Information architecture

| Menu (EN / VI)         | Route                          | Replaces                                                    |
| ---------------------- | ------------------------------ | ----------------------------------------------------------- |
| To-do / Việc cần làm   | `/`                            | Overview                                                    |
| Productions / Sản xuất | `/productions` (`?view=board`) | `/content` (library) and `/pipeline` (board); both redirect |
| Projects / Dự án       | `/projects`                    | unchanged; Brand, Masters, Costs become project tabs        |
| Library / Thư viện     | `/assets`                      | Asset library                                               |
| Costs / Chi phí        | `/costs`                       | new workspace-wide view (sum of project budgets and spend)  |
| Operations / Vận hành  | `/operations`                  | unchanged                                                   |
| Settings / Cài đặt     | `/settings/[section]`          | one page with a section select                              |

`/masters` stays reachable (project tab and a link from Productions). The content workspace stays
at `/content/[id]` so deep links keep working. Phone bottom bar (5): To-do, Productions, Library,
Operations, Menu.

## 3. Design system ("Studio 2")

- Tokens extend `globals.css`: `--info`, `--review` families; dark mode still redefines tokens only.
- **Status badge** (`components/status-badge.tsx`): one component for job, stage, gate and cost
  states — icon + label + tone, never colour alone. 14 states: draft, queued, running, retrying,
  review, approved, changes requested, failed, blocked (policy/auth/invalid), budget hold,
  delivered (P3d), reused, exported, canceled. `StatusPill` keeps its API and renders through it.
- **Price on the button**: `~$0.42` for an estimate, `?` in the warning tone for an unknown price;
  never `$0` for unknown (CLAUDE.md §2.13).
- Fonts: Be Vietnam Pro (body, `latin`, `latin-ext`, `vietnamese`), Manrope (display),
  self-hosted by `next/font`.

## 4. Screens

1. **To-do** (`/`): a queue of decisions: open gates (script, storyboard, scenes, render QC),
   failed jobs to fix, delivered-but-unfinished jobs (P3d "Finish — no new charge"), budget holds
   and items near their limit. Each row has its primary action inline. Side panels: Running now,
   Ready to download. Built by a pure `lib/todo.ts` (unit tested) from existing endpoints.
2. **Workspace** (`/content/[id]`): a **stage rail** (Brief · Script · Storyboard · Scenes ·
   Render · Export, gates G1–G4 marked) replaces both the stepper and the tabs; an **action bar**
   with the next step, its price and one button sits under the title (desktop) and as a fixed
   bottom sheet (phone); Activity becomes a **history drawer**.
3. **Review mode** for G1 script, G2 storyboard, G3 scenes (keyframes/clips), G4 render QC: content
   left, checklist + decision right, "Request changes" needs a note, keys A / R / J / K / 1–4 /
   Space / C / Esc. Version diff for script and storyboard text (previous version vs current).
4. **Jobs tray** in the top bar: running / queued / failed counts, list of the user's active
   jobs, toast when a job on another page finishes; `aria-live="polite"`.
5. **Cost confirmation dialog** (`components/cost-confirm.tsx`): shows lines, total, why it
   appears ("above your $1.00 threshold — change in Settings", "one price is unknown, so we
   always ask") and the budget left after the run.
6. **Settings** as sub-routes: General, Profile & language, Budgets & spending, Voice profiles,
   AI providers, Models & prices, Change log, System status.
7. **Costs** (`/costs`): workspace total this month, per-project spend vs limit.

## 5. API and database changes

All money stays `Decimal` USD in PostgreSQL and decimal strings in JSON (ADR-0012), like
`project_budgets`.

| Change                                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users.locale`                             | `VARCHAR(8) NULL`, `'en' \| 'vi'`; `NULL` = follow the browser. `GET /api/v1/auth/me` returns it; `PATCH /api/v1/auth/me/preferences { locale }` sets it (any signed-in user, own row only).                                                                                                                                                                                                                                    |
| `workspace_settings`                       | New singleton table (`id SMALLINT PRIMARY KEY CHECK (id = 1)`, `confirm_threshold_usd DECIMAL(14,6) NOT NULL DEFAULT 1`, `updated_by_id`, timestamps). `GET /api/v1/settings/spending` (signed-in), `PUT` (operators, `OPERATOR_EMAILS`). Validation: 0 ≤ value ≤ 1000, at most 2 decimals.                                                                                                                                     |
| `project_budgets.confirm_threshold_usd`    | `DECIMAL(14,6) NULL` override; set through the existing budget `PUT` (same permission). Project budget DTO returns `confirmThresholdUsd` and `effectiveConfirmThresholdUsd`.                                                                                                                                                                                                                                                    |
| `GET /api/v1/events`                       | `text/event-stream`. Topics: `user` (always) and `content:{id}` (query `content=`). Events: `job` deltas `{id, jobId, projectId, contentItemId, kind, sceneId, from, to, attempt, at}` and `content` deltas `{contentItemId, status, at}`, filtered by project membership. Heartbeat `:ping` every 25 s, `retry: 5000`, `X-Accel-Buffering: no`. Resume with `Last-Event-ID`; a gap over 15 min or 1,000 events sends `resync`. |
| `GET /api/v1/jobs/changes?since=&content=` | Same deltas as JSON with `cursor`; `ETag` / `304 Not Modified`. Fallback when SSE is unavailable.                                                                                                                                                                                                                                                                                                                               |

**Event source (performance).** The API runs **one shared tailer** per process that reads new
`job_events` rows (index `(created_at)`) once a second while at least one client is connected and
fans them out in memory to every stream. Cost is one indexed query per second per API process,
independent of the number of browsers or tabs; PostgreSQL stays the source of truth (rows are
read only after commit), nothing is lost if Redis is down, and the worker is unchanged. The
tailer re-reads a 5-second overlap window and de-duplicates by event id, because ids are
generated before commit. Cursor = `createdAt` ms + event id. Redis pub/sub wake-ups for multiple
API instances are a follow-up (staging runs one API process, ADR-0021).

**Client.** `lib/live/` holds the store (`useSyncExternalStore`), leader election
(`navigator.locks`, with a `BroadcastChannel` heartbeat fallback), the `EventSource` and the
polling fallback (3 s with running jobs, 15 s idle, 60 s hidden, exponential backoff + jitter on
errors, retry SSE every 5 min). When every tab is hidden for 2 minutes the leader closes the
stream and resumes by cursor on return. Workspace screens refresh their server data
(`router.refresh()`, debounced 400 ms) when an event for the open item arrives — one refresh per
change instead of interval loops.

**Cost confirmation.** The API contracts that require `confirmedEstimateUsd` stay. The client
fetches the estimate and, when the total is known and ≤ the effective threshold, generates
immediately with that total; otherwise it opens the dialog.

## 6. Internationalisation

- `lib/i18n/{en,vi}.ts` with the same keys (a unit test checks parity and placeholders);
  `t(key, vars)` for client and server; plurals via `{count}` keys `*.one` / `*.other`.
- Locale resolution on the server: user preference → `acf_locale` cookie → `Accept-Language`
  → `en`. `<html lang>` follows it; client components read it from a React context, so there is
  no flash of the other language.
- Formatting: `Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })`, dates in the
  user's time zone (stored UTC). Glossary keeps scene, keyframe, storyboard, render, prompt in
  English inside Vietnamese text.
- Layout: buttons and badges have no fixed width; rows wrap; a short label set for the bottom bar.

## 7. Slices

| Slice | Content                                                                                                                                          | API                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| R0    | Foundations + i18n: dictionaries, locale resolution, `users.locale`, preferences endpoint, user-menu language switch, font, status badge, tokens | `users.locale`, `PATCH /auth/me/preferences`           |
| R1    | Shell & IA: 7-entry nav, bottom bar, `/productions`, `/costs`, project tabs, redirects                                                           | none                                                   |
| R2    | To-do home page                                                                                                                                  | none                                                   |
| R3    | Workspace spine: stage rail, action bar, history drawer                                                                                          | none                                                   |
| R4    | Review mode for G1–G4 with checklist and diff                                                                                                    | none                                                   |
| R5    | Live jobs (events endpoint, tailer, client store, jobs tray) and the cost-confirmation dialog with thresholds                                    | events, changes, `workspace_settings`, budget override |
| R6    | Settings sub-routes incl. Budgets & spending and Profile & language; Library and Operations polish                                               | none beyond R5                                         |
| R7    | Phone, dark mode and Vietnamese QA; E2E in both languages                                                                                        | none                                                   |

## 8. Acceptance

- Every visible string comes from the dictionaries; `vi` and `en` have the same keys.
- Switching language updates the UI without a reload and persists for the user.
- Old routes (`/content`, `/pipeline`) redirect with their query strings; E2E passes.
- With N tabs open, the browser holds one events connection; with no client the API runs no
  tailer query.
- A paid action at or below the threshold with a known price runs in one click; above it or with
  an unknown price the dialog appears; the threshold can be changed per workspace and project.
- Lint, typecheck, unit tests, build and E2E pass.

## 9. Risks

- Route changes break bookmarks and E2E selectors → redirects, role/label selectors.
- SSE behind a proxy → no buffering header, 25 s heartbeat, automatic polling fallback.
- Vietnamese strings are 20–35 % longer → wrapping rows, no fixed widths, phone checks at 390 px.
- Prices in the mockups are layout examples only; the UI reads prices from the registry.

## 10. Implementation notes

All slices are implemented (2026-11-24). Lint, typecheck, unit tests, build, the API integration
suites touched by the redesign and the full E2E suite (23 tests, English and Vietnamese, phone
390 px) pass.

- **R0 Foundations + i18n.** `lib/i18n/{en,vi}.ts` (same keys; `i18n.test.ts` checks parity and
  placeholders), `getT()`/`getLocale()` on the server (profile → `acf_locale` cookie →
  `Accept-Language` → English), `useT()`/`useLocale()` in client components, `<html lang>`.
  `users.locale` and `PATCH /auth/me/preferences`. Be Vietnam Pro replaces DM Sans. Status badge
  with icon + label + tone (`components/status-badge.tsx`); tokens `--info`, `--review` (contrast
  checked in `design-tokens.test.ts`). Job error texts have Vietnamese versions. New components'
  CSS lives in `app/redesign.css`; `globals.css` was not split (no broad refactor).
- **R1 Shell & IA.** Seven menu entries, phone bottom bar with four destinations and Menu,
  `/productions` (list, `?view=board`), `/costs` (workspace), project tabs (Content, Brand,
  Masters, Costs, Library); `/content` and `/pipeline` redirect with their query strings.
- **R2 To-do.** `lib/todo.ts` (unit tested) builds the queue from the content lists and the
  operations summary: failures first, held reservations, input needed, open gates, budgets near
  their limit; side panels Running now and Ready to download.
- **R3 Workspace spine.** Stage rail (Brief & script, Storyboard, Scenes, Render & export; gates
  1–4) replaces the stepper and the tabs; the Next-step action bar sits under the title (sticky
  above the bottom bar on phones); Activity and version history moved to a drawer (`#activity`
  opens it). The six-step stepper's "Keyframes" and "Clips & voice" are the Scenes stage.
- **R4 Review mode.** `ReviewPanel` for gates 1–2 and the render gate: checklist (R-D3: automatic
  items pre-ticked, "Check all", ticks in `localStorage` per version), Approve, Request changes
  with a required note (sent as the rejection note), keys A / R / C inside the panel; word diff of
  the voice-over against the previous script version. Gate 3 keeps per-asset review on the Scenes
  board, with J / K between scene rows. Earlier versions keep their plain approve buttons.
- **R5 Live jobs and cost confirmation.** ADR-0022. API: `GET /events`, `GET /jobs/changes`,
  `GET /jobs/active` (`apps/api/src/live/`), index `job_events(created_at)`; integration tests in
  `apps/api/test/live/`. Web: `lib/live/` (reducer with unit tests, store, leader tab,
  BroadcastChannel, polling fallback), Jobs tray in the top bar, workspace and job list refresh on
  events; the two-second `AutoRefresh` loop and the per-component polls are gone. Thresholds:
  `workspace_settings`, `project_budgets.confirm_threshold_usd`, `GET/PUT /settings/spending`;
  images, clips and voice-overs show the estimate on their button and ask with
  `CostConfirmDialog` above the threshold or with an unknown price (`lib/cost-confirm.ts`, exact
  decimal comparison, unit tested). Money stays `DECIMAL(14,6)` USD, as in `project_budgets`
  (ADR-0012), instead of integer micros.
- **R6 Settings, Library, Operations.** `/settings/<section>` (General, Profile & language,
  Budgets & spending, Voice profiles, AI providers, Models & prices, Change log, System status);
  `/settings?section=` redirects. Operations starts with a health strip. Library labels and
  lineage are translated.
- **R7 Phone, dark, Vietnamese QA.** E2E: language switch and persistence, phone layout without
  horizontal scroll on eight pages in both languages; screenshots checked in light, dark and
  phone. Remaining English by design: see KNOWN_LIMITATIONS.md "Interface language".

Not done / follow-ups:

- Model import dry-run diff and per-price source column in Models & prices (listed in the visual
  design) are unchanged from P1d.
- No pseudo-locale run; Vietnamese itself is checked at 390 px instead.
- Staging: confirm the Jobs tray shows **Live** behind Caddy after the next deploy.
