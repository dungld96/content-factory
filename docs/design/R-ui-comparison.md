# Redesign R — built UI compared with the design canvas

Date: 2026-11-24, second pass. Canvas: the design artifact linked from `R-redesign-package.md`
(v22).

**Method.** Each canvas artboard was rendered at its own size (1440 px desktop, 390 px phone)
and placed beside a screenshot of the built app at the same size. The app was signed in as the
E2E owner on the E2E seed (3 projects, mock providers). The data differs from the canvas mock
data, so amounts, titles and thumbnails differ by design. The screens were rebuilt, compared and
corrected until layout and components matched.

**Approach.** The canvas stylesheet (`studio.css`: tokens, buttons, badges, cards, inputs,
chips, tables, meters, rail, action bar, dialogs) is ported verbatim into
`apps/web/src/app/ds.css`, scoped to `.ds`. Page layouts are in `apps/web/src/app/shell.css`.
Every studio page uses the canvas class names, so a screen and its artboard share one design
system. The theme follows the system, or the sidebar moon/sun toggle (`acf_theme` cookie).

## Screens

| Canvas artboard | App | State |
|---|---|---|
| Shell | studio layout, `components/shell/*` | Matches: brand, project switcher, grouped menu with badges, spend meter, account menu (language, profile, sign out), theme toggle, breadcrumb, search, running pill, New content |
| To-do / Phone · To-do | `/` | Matches: "N things need you", tabs, decision rows with gate badges and waiting time, In production meters, Running now (live jobs), Ready to download. Phone: decision cards with a full-width action |
| New content | `/productions/new` | Matches: four sections, product photos (upload or Library), voice-over and profile, brief check, estimated run cost from routed model prices, Create & write script / Save as draft, draft autosave |
| Productions | `/productions` | Matches: List/Board, chips, six stage columns with gate counts, cards with status and this month's cost |
| Workspace (light, dark, VI) | `/content/:id` | Matches: header with spend and budget, six-step rail with G1–G4, dark Next-step bar with Skip, scene board, cost by stage, latest activity |
| Gate 1 · Script review | `/content/:id#script?focus=1` | Matches: full-screen focus review, Before you approve, Brief, Decision (note, Approve [A], Request changes [R]) |
| Render | Render stage | Matches: Settings and Render steps, review of the latest render (player, checks, checklist, approve/reject), Export table with details, checksum and size |
| Library | `/assets` | Matches: collections and types rail, chips, grid/list, asset cards with review state, details and lineage panel |
| Operations | `/operations` | Matches: health cards, Needs attention with recovery actions, queues with load, last 24 hours with budgets |
| Costs & budgets | `/costs` | Matches: four KPIs, spend per month, budgets with spent/reserved meters, most expensive items |
| Settings (Models, Budgets, Language) | `/settings/*` | Matches: grouped section menu, section as page heading; section bodies keep their existing forms |

## Remaining differences (data or not yet built)

- **Data the API does not expose yet:**
  - per-item cost split by capability and regenerations on Costs;
  - worker heartbeats and media tool health on Operations (the canvas "Workers", "Media tools" cards);
  - stacked spend per capability per month (the chart shows monthly totals; this month by stage is in the table view).
- **Interactions not built yet:**
  - multi-select with "Retry selected" on the scene board;
  - v1/v2 switch and To-do previous/next inside focus review;
  - focus review for the keyframe gate (G3);
  - import preview diff card in Settings › Models;
  - inline per-project overrides in Settings › Budgets (edited on the project Costs tab).
- **Intentional:**
  - the phone bottom bar keeps Menu (it opens the full menu) where the canvas shows Costs;
  - Export opens the render's export table instead of a separate panel.
