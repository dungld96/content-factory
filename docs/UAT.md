# User acceptance test (UAT)

A walk-through of the whole product for a person who did not build it. Run it on the staging
site (or locally), take about 60–90 minutes, and note anything unclear, slow or wrong: unclear
counts as a finding too. Real AI providers cost money: the full run costs about **USD 1–1.50**
with the routes in DEPLOYMENT.md §5 (one 30 s video). Use a project with a **USD 3 hard** budget.

How to record: for each scenario write **Pass**, **Fail** (what happened) or **Unclear** (what
confused you) in the "Result" column, and send the file back.

You need: an owner account, an editor account and a viewer account (DEPLOYMENT.md shows how an
operator creates them), and the site address.

| #   | Scenario                     | Steps                                                                                                                                                         | Expected                                                                                                                         | Result |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Sign in                      | Open the site, sign in as the owner. Try a wrong password once.                                                                                               | Wrong password: a clear message. Right password: the Overview page.                                                              |        |
| 2   | Project and budget           | Projects → New project (your language and timezone). Open it → **Costs** → set monthly USD 3 hard, per item USD 3 hard, per request USD 2 hard → Save.          | The project appears; the Costs page shows the new limits and USD 3 remaining.                                                    |        |
| 3   | Content and brief            | In the project: New content (title, topic, audience, tone, 30 s, 9:16, your language, platform). Open it.                                                      | The content page shows "Brief ready" and the six-step progress bar.                                                              |        |
| 4   | Script (gate 1) | Generate script (leave Model on "Default (task route)"). Read it. Regenerate once, then open **Earlier versions** and approve the version you prefer. | A script in your language within seconds; each generation or edit creates a version; the approved one is marked "in use". | |
| 5   | Storyboard (gate 2) | Storyboard tab → Generate storyboard. Check that every scene lasts one of the clip model's lengths (4, 6 or 8 s for Veo 3.1 Lite). Edit one scene's text with **Edit scene**. Approve. | 3–6 scenes with prompts and narration per scene, already at clip lengths; a broken rule is named in the error; approval unlocks keyframes, clips and voice-overs. | |
| 6   | Keyframes (gate 3)           | Keyframes tab → Estimate cost → Generate images (2 per scene). Approve one image per scene and **Use as keyframe**.                                          | The estimate appears before spending; images arrive in about a minute; every scene ends with a keyframe.                         |        |
| 7   | Voice profile | Settings → Voice profiles: create one (choose MAI-Voice 2.1, type the language `vi-VN`, pick a voice from the list). On the content's Voice-over tab, choose it. | Only enabled models are offered; the voice list shows the model's voices for that language; the profile is listed and offered on the Voice-over tab. | |
| 8   | Clips and voice-overs (gate 4) | Clips tab → Estimate cost → Generate clips (confirm the total). Voice-over tab → Estimate → Generate. Approve and select one clip and one voice-over per scene. | Clips take 1–3 minutes; voice-overs seconds; a voice-over longer than its scene is flagged on the Voice-over tab with the overrun and the fixes. | |
| 9   | Render and export (gate 5) | Render & export → Render video. Watch it with captions on. Approve, then Export package; download the files. | Automated checks pass; captions break at phrases, no cue flashes by in under a second; the package has video, captions, thumbnail, manifest and cost report. | |
| 10  | Costs                        | Project → Costs.                                                                                                                                              | This month's total (about USD 1–1.50), by content item, stage and model; reported vs estimated kept apart.                       |        |
| 11  | Budget protection            | Set the per-request limit to USD 0.10 (hard), then try to generate clips for a scene again (Regenerate).                                                      | Refused before anything is queued, with a message naming the per-request budget. Set it back afterwards.                         |        |
| 12  | Operations and Resume        | Open **Operations**.                                                                                                                                          | Queues, failed jobs (each with **Resume**), providers and budgets; nothing unexpected failed.                                    |        |
| 13  | Roles                        | Sign in as the viewer: open the content and the Costs page. Sign in as the editor: try to change the budget.                                                  | Viewer sees everything but cannot generate, approve or edit; editor generates and approves but cannot change budgets.            |        |
| 14  | Backup and restore (operator) | On the server: `./acf.sh backup`; on a scratch server or after `./acf.sh down -v`, `./acf.sh restore <name>` and `./acf.sh up -d`; sign in and open the exported video. | The restore reports every check passed; the content, its versions and the video are back.                                    |        |
| 15  | Scheduled off-server backup (operator) | Set up the rclone remote and `BACKUP_REMOTE` (DEPLOYMENT.md), run `./acf.sh backup-schedule install`, the next morning `./acf.sh backup-schedule status` and `rclone lsd <remote>`. | Status shows the 02:15 schedule and no failure; last night's backup is at the remote with its `backup.json`. | |

## Run 1: Claude, local stack, 2026-11-20

Scenarios 1–10 and 12 were run through the web UI during the M8 pilot (real providers; screenshots
and the report: `docs/design/m8/pilot-report.md`); 11 and 13 are covered by the automated end-to-end
and API tests (budget refusal, permission matrix); 14 by the restore drill
(`docs/design/m8/restore-drill.md`) on the local stack, not yet on a server.

| #   | Result  | Notes                                                                                                                                                  |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Pass    |                                                                                                                                                        |
| 2   | Pass    |                                                                                                                                                        |
| 3   | Pass    | Objective and call to action are optional ("the model will choose")                                                                                    |
| 4   | Pass    | Unclear: only the latest version can be approved (pilot F4)                                                                                            |
| 5   | Pass    | After fixes: Gemini rejected the storyboard schema (F1, rerouted); scene duration was not editable (F2, fixed in M8c); edit order matters (F6)        |
| 6   | Pass    |                                                                                                                                                        |
| 7   | Unclear | The exact voice id had to be looked up; the model list starts with a disabled model (F5)                                                               |
| 8   | Pass    | Scene 4's narration was too long; only the render tab said so (F7)                                                                                    |
| 9   | Pass    | Caption cues could be split better (F9)                                                                                                                |
| 10  | Pass    | USD 1.06                                                                                                                                               |
| 11  | Pass    | Automated (`budgets.integration.test.ts`); not repeated by hand                                                                                        |
| 12  | Pass    | Resume recovered the failed storyboard                                                                                                                 |
| 13  | Pass    | Automated (permission matrix, Costs page E2E)                                                                                                          |
| 14  | Partly  | Local drill passed; `acf.sh restore` on a server still to be run                                                                                           |

Run 1 findings for 4, 5, 7, 8 and 9 are addressed by M8.5 (Q3–Q7); scenario 15 is new in M8.5.

## Run 2: owner

_To be filled in by the owner (or a colleague) on staging._
