# Redesign R — built UI compared with the design canvas

Date: 2026-11-24. Canvas: the design artifact linked from `R-redesign-package.md` (v22).

**Method.** Each canvas artboard was rendered at its own size (1440 px desktop, 390 px phone)
and placed beside a screenshot of the built app at the same size. The app was signed in as the
E2E owner on the E2E seed (3 projects, mock providers). The data is not the same as the canvas
mock data, so amounts and titles differ by design. Only layout, function and visual treatment
were compared.

**Categories.**

- **Fixed**: drift corrected in this pass.
- **Missing**: a canvas function that the app does not have yet. These are listed as follow-ups.
- **Intentional**: a difference that is kept, with the reason.

## Shell (every screen)

| Item | Category | Note |
|---|---|---|
| Menu groups Work / Resources / Control | Fixed | `nav-items.ts` `group`; group labels in EN and VI |
| Badges on To-do, Productions and Operations | Fixed | Streamed behind Suspense; the reads are shared with the page through a per-request cache |
| Monthly spend meter at the bottom of the sidebar | Fixed | `lib/spend.ts` sums the project budgets: spent, reserved and the sum of monthly limits |
| Compact brand (no subtitle) | Fixed | |
| "All projects" switcher that scopes every page | Missing | The app shows a static workspace card. Scoping needs a project filter on every page |
| Dark-mode toggle in the sidebar | Missing | The app follows the system setting |
| Topbar "N running" pill and New content button | Intentional | The Jobs button shows the running count and opens the tray (R5). New content stays in the page header |
| Breadcrumb "Productions › title" | Missing | The app shows "Workspace / Content workspace" |

## To-do (home)

| Item | Category | Note |
|---|---|---|
| Heading "N things need you" plus a "running · spent of limit" line | Fixed | |
| Tabs Needs you / Following / Done today | Missing | |
| Waiting time on the right of each row | Intentional | The time is shown in the row's subline |
| "In production" progress panel; Running now with job progress | Missing | Running now lists the content items, not the jobs |
| Thumbnails and download buttons in Ready to download | Missing | |

## Productions

| Item | Category | Note |
|---|---|---|
| Board: the sixth column wrapped to a second row at 1440 px | Fixed | Bug. The columns now always sit on one row and scroll sideways on narrow screens |
| Waiting count in the column header and a ring on cards waiting for a decision | Fixed | |
| Filter chips All / Needs you / Running / Failed | Missing | The list view already has status filters |
| Card thumbnail, cost and progress bar | Missing | Needs a per-item cost and thumbnail in the content list API |

## Content workspace

| Item | Category | Note |
|---|---|---|
| Next-step bar: dark, placed under the stage rail | Fixed | |
| Spend in the header ("$ spent", "budget $ left") | Fixed | The cost moved from the Next-step bar to the header |
| Six steps (Brief, Script, Storyboard, Scenes, Render, Export) | Intentional | The app has four: "Brief & script", Storyboard, Scenes, "Render & export". The brief and export have no gate of their own, so a separate step would add a click with no decision |
| "NEXT STEP · 1 OF 3" counter and "Skip for now" | Missing | |
| Scene board multi-select, "Retry selected" and "Generate · ~$" in the board header | Missing | Retry and generate are per scene or per stage |
| Bottom row: cost of this item by stage, and Latest activity | Missing | The app shows the cost box; activity is in the History drawer |

## Review gates (script, storyboard, keyframes, render)

| Item | Category | Note |
|---|---|---|
| Full-screen focus mode (close button, gate tag, v1/v2 switch, To-do previous/next) | Missing | The app reviews inside the stage panel (R4 review panel, checklist, diff, keys A/R/C) |
| Keyframe focus mode (scene strip, large candidates, "Choose #n & next scene", keys ←/→, 1–4, G) | Missing | |
| Phone review sheet with sticky Approve/Reject | Missing | The phone shows the same panel as the desktop |

## Render, Library, Operations, Costs, Settings

| Screen | Item | Category |
|---|---|---|
| Render | Two columns (settings summary, review); QC findings with Jump links; scene timeline; export table with checksums | Missing |
| Library | Collections rail with counts; chips All/Approved/Needs review; grid/list toggle; detail panel (Used in, New version) | Missing |
| Operations | Health cards; Needs-attention table with recovery actions; Done/Failed 24 h per queue; "Show idle queues" | Missing |
| Costs | Period switch; stacked chart by capability; budgets with reserved stripes; most expensive items; Export CSV | Missing |
| Costs | Unknown cost shown apart and never as $0 | Matches |
| Settings › Models | Import preview from OpenRouter; capability chips; switch per model | Missing; the app has import in P1d and status badges |
| Settings › Budgets | Per-project overrides edited inline; "What people will see" examples | Missing; overrides are edited on the project Costs tab |
| New content | Full page with brief check and estimated run cost | Missing; the app uses a dialog |

## Phone

| Screen | Item | Category |
|---|---|---|
| To-do | Card per decision with a full-width action button; badge on the bottom bar | Missing |
| Workspace | Compact header "Step n of 6" with a progress bar; sticky bottom action | Partly. The app has the compact step line and a sticky Next-step bar |

## Follow-ups (highest value first)

1. Focus review mode for gates 1–4, on desktop and phone.
2. Productions board cards: cost, thumbnail and progress; filter chips.
3. Scene board multi-select with batch retry and generate.
4. To-do: Running now from the live job store, and Ready-to-download thumbnails.
5. Render two-column layout with an export table.
6. Library collections rail and detail panel.
7. Operations Needs-attention table.
8. New content as a full page with an estimated run cost.
9. Project switcher in the sidebar.
