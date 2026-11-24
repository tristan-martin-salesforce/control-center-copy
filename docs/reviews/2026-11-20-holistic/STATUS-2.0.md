# Command Center 2.0: build status (2026-11-21)

The unattended build that followed the 2026-11-20 holistic review is complete on `tmart2322/control-center-port-polish` (the `kraken` worktree), committed locally and **not pushed**. The last commit is `chore(release): v2.0.0`, with no tag (your call, README §8). 33 chunks over waves 0–4 plus the release pass; every chunk's row, sha and notes are in `CHUNKS.md`. Three Fable reviews gated the waves: `13-wave0-review.md`, `14-wave12-review.md`, `16-wave34-review.md`.

## 1. What is green at the release commit

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors, 27 warnings (all pre-existing max-lines) |
| `npm test` (unit + ui) | 409 files, 4,506 passed, 11 skipped (at the final commit, after the W34-1 fix) |
| `npm run test:db` (every Postgres project, serial, fresh databases) | 85 files, 938 passed, 6 skipped (at the 2.0.0 commit; the W34-1 fix after it touches only ops scripts and unit tests) |
| `npm run test:evals` (scanner golden set, FTI and agentic) | 181 passed, 1 skipped |
| `npm run smoke:crawl -- --mock` | 43 of 43 pages, no console or page errors |
| `npm run build:release -- --smoke` | `dist/command-center-2.0.0-arm64.tgz`, 27.5 MB (12,589 files verified after unpack); web `GET /` 200 and `/api/v1/version` → v2.0.0; worker: bundled migrate, first heartbeat, clean exit **That 27.5 MB build lacked the bundled Postgres engine** (its optional dependency was not installed in this checkout; found by the install walk, `20-onboarding-dry-run.md` ON-13): never publish it. The build now refuses that case; §6.5 has the real artifact. |

Known noise: `tests/ops/doctor.test.ts` can time out when the whole unit project runs in parallel on a loaded machine (passes alone and on rerun); `tests/feedback/agent.test.ts` fails inside agent worktrees because `node_modules` is a symlink that resolves outside them; it passes in the main checkout.

## 2. The original asks

Numbering as in `14-wave12-review.md` §original asks. "Live" means a check that only the work machine can run (§4).

| # | Ask | Status | Evidence |
|---|---|---|---|
| 1 | UI quality: drafts list, Needs-you queue | done | Component kit (`src/components/kit`, gallery at `/dev/kit`), two-group sidebar, Settings in six groups, Home as a briefing with the Respond strip, Activity = To log · History · VDP with a Review page, Health ▸ Setup. Contrast suite 140 pairs; crawl 43/43. Open: visual parity of the row components with the detail panel open was reviewed from closed-panel shots only. |
| 2 | Scanners miss and auto-close | done, in shadow | Resolution check (`src/engines/resolution`, migration 0031) decides every close with a why and Undo; shadow by default, Health shows its agreement with the old closer. Golden set: 14/14 closures on both paths; SCN-1 flipped, SCN-4 stays agentic-only. Switch to live in Settings ▸ Sending after a week of agreement data. |
| 3 | Scanning cost → very cheap | done, measured offline | Fetch-then-interpret is the default scan mode: 0.15× the agentic path on the golden set with the same closures. Every call is booked in `llm_calls`; `scan:report --yield` shows cost per mode. Live: one day of real scans confirms the relay size the estimates assume. |
| 4 | Assistant usefulness, no arbitrary caps | done | Assistant v2: 11 tools, `query` over curated read views, Auto routing (Haiku/Sonnet/Opus) with a cost line, persisted SDK sessions and memory (0035), plan card, raise-hand card, Allow $X more resumes the same run. No numeric caps remain except budgets you set. |
| 5 | Spend caps = estimate → warn → raise hand → continue | done | Spend governor (`src/spend`, `spend_holds` 0030): estimate, hold, ask, settle; day-budget ask for scans; holds visible in Health and the scan report. Live: the PreToolUse hook holding a real `claude -p` run while the card waits. |
| 6 | Time logging: auto-attribution, Org62 discovery, DC suggestions, "AEs I cover" | done; Org62 discovery live-unverified | `src/engines/attribution` (0032): learned mapping rules, live `org62.discover` job, `opp_engagement`, DC suggestion rule and daily batch, AEs I cover setting + lookup job, suggestion outcomes. Use-case candidates from notes (0034). Activity Review page of checkboxes. Live: the team and account SOQL through the one-call path. |
| 7 | Pluggable connectors + LLM provider | done | `ConnectorRuntime` with four transports, one manifest + registry per connector, read-tool allowlist per manifest (still 21 tools, unchanged), `ModelProvider` seam with the Agent SDK adapter, SDK-import lint. |
| 8 | Data model correctness | done | Side-car → columns (D-99, 0036) with dual read and a backfill job; `need_decisions`, `canvas_row_overrides`, id15 generated columns, VDP child tables, message landings; FK/check counts pinned in `tests/db/core`; journal hygiene tests. Live: `npm run db:backfill -- --dry` then the worker's `kv.backfill` job. |
| 9 | Light structure docs + lint | done | CONTRIBUTING.md, AGENTS.md, layer lint, max-lines, ARCHITECTURE as built, ADRs 0088–0101 indexed in DECISIONS.md, docs/README index, 10-rule time spec. |
| 10 | Module-isolated testing | done | vitest projects `unit` / `ui` / `db*` (serial) / `evals` / `smoke`; lane folders moved to module folders; route-drift, scope-lint, layout and rename-grep tests. Missed target: a leaf engine file still has 131 related tests because the mock barrel loads everything (post-2.0). |
| 11 | Maintainability refactor | done | DataSource split by domain behind an unchanged interface: `db/domains/*`, `mock/domains/*`, shared read views in `src/server/views` (about 360 duplicated lines removed), per-domain types, `db-entry.ts`; `db/index.ts` 379 lines, `mock/index.ts` 496. Left as twins on purpose: `buildToday`, `buildTriage`, `buildTime` (behaviour differs). The mock DataSource is kept (PGlite spike said no). |
| 12 | Packaged app + updates + Slack feedback intake + compliance | done; real install is yours | Compiled build with staged install and rollback, bundled Postgres 17 (D-98), releases to a shared Drive folder + Slack announcement as Outbox drafts you approve (`release.announce`, `release.drive_upload`), update check through the Drive read path, `docs/INSTALL.md` one-prompt install. Compliance: reads stay MCP-through-Claude-Code, no SDKs, no app-held tokens, loopback bind. Live: the install on the work Mac, the devbar Drive read of `manifest.json`, one teammate end to end. |
| 13 | Migration path for data changes | done | Additive migrations 0027–0036 with journal/snapshot discipline; the migrator refuses an out-of-order journal; `update.mjs` backs up, migrates, rolls back on failure; the 1.x → 2.0 folder, service and database rename is idempotent and resumable (D-101, `EDGE-CASES.md` MG-01..13). |
| 14 | Out of the box for non-technical users, end-to-end errors | done; teammate run is yours | Health ▸ Setup driven by the doctor with Run buttons, one error catalog with codes, "The database isn't running" page with the command, Getting started with 5 outcomes, feedback reports with a redacted diagnostics block. |

## 3. Scope narrowings and known gaps (decided during the build)

- **PGlite** as the app database: spike verdict **no** (the socket multiplexer corrupts concurrent clients). Bundled Postgres 17 instead, per the pre-approved fallback. PGlite for tests and retiring the mock DataSource are deferred.
- **Resolution check and priority@2 ship in shadow.** Switching them live is a Settings toggle after you have seen their agreement numbers on real data.
- **Activity review**: `CorrectionRow.reopenUndoId` has no contract carrier yet (the row reopens, the panel does not offer that undo).
- **DataSource split step 5**: the import fan-out target (leaf engine → under 40 related tests) was missed; the fix is in the engines barrel, not the DataSource.
- **Rename**: test database prefixes (`control_center_*`), `CC_*` variables, the repository folder and the team Slack channel `#jedais-control-center` keep their names (rename the channel in Slack first, then `config/team.json`). `sample-data/tables/tool_adapters.json` has keys and versions that fail the `ToolAdapter` contract, so the sample database does not load a read model until it is fixed.
- **Release Outbox items** were first written to `dist/releases/outbox-<v>.json` and then wired into the in-app Outbox by `p4-release-outbox-items`; both paths exist.
- Builders signed their commits as Claude Opus 5.5 (the model that ran); the integration commits carry Fable 5.1.

## 4. On the work machine, in this order

Everything here was tested with fakes or scratch clusters; none of it ran against your live install, LaunchAgents or external systems (CLAUDE.md invariants 1 and 6).

1. **Before pushing anything**: `npm run scan:private` (the review folder names Org62 ids and customers; `docs/research` is excluded from the build but tracked files are scanned). Then push `tmart2322/control-center-port-polish` to your fork and open the PR into your other account.
2. **Record the 1.x state**: `launchctl list | grep -E 'controlcenter|commandcenter'`; `ls ~/Library/Application\ Support | grep -i center`; the database list for `%center%`. Run `npm run backup` on 1.x and copy `~/Library/Application Support/control-center/backups/` elsewhere.
3. **Dry look**: after pulling 2.0, `node scripts/ops/migrate-state.mjs --check` prints what would move and changes nothing. `npm run update -- --dry` shows the update plan.
4. **Upgrade**: `npm run update` once from the 1.x checkout. Watch `~/Library/Logs/command-center/migrate.log`. Expect the app back on :4327 within about a minute. Then verify: `command-center` folder present, `migration.json` says `migratedFrom: control-center` with `database.status: renamed`; `launchctl list | grep commandcenter` shows web and worker, nothing for `controlcenter`; the database is `command_center`; `npm run doctor` is green; Home loads your data. If it did not finish in two minutes: `node scripts/ops/migrate-state.mjs` (safe to repeat). A Homebrew 1.x database then moves into the bundled cluster on a second `npm run update` (D-98; Homebrew Postgres must be running).
5. **Data**: `npm run db:backfill -- --dry`, then let the worker's `kv.backfill` job finish (`npm run doctor` → `data:kv-fallback ok`). Deals, To log, the account page and VDP must read the same before and after.
6. **Reads**: `DATABASE_URL=<app db> npm run db:read-profile -- --route all --runs 11 --compare` (counts only); Home, Today and Needs under ~150 ms; after a day, no `BUG.READ_SCOPE_MISS` in the web log. `CC_READ_SCOPES=off` restores the 1.x reads if a page looks wrong.
7. **Scanning**: one Slack inbox poll and one Org62 events poll in the default FTI mode; `npm run scan:report -- --yield --since 24h` after a day (relay sizes, cost per mode, holds, resolution-check yield). Compare a day of FTI verdicts with `CC_SCAN_MODE=agentic` on the same window before trusting the 0.15× number live.
8. **Engines**: Health shows "Resolution check agreed on N% of M closes" and "Ranking: priority@2 in shadow · agrees x.xx". Toggle Preview new ranking on Today and judge the Top 3. Run `org62.discover` once and check the team/account SOQL return through one-call; Settings ▸ Time ▸ AEs I cover ▸ Find with Org62.
9. **Assistant** (`CC_CHAT_LLM=1`): two messages in one thread resume the SDK session; a research question shows the plan card; a $0.05 per-message limit shows the spend card and Allow $X more continues the same run; `search source vdp` uses `search_vdps {query}` (argument name is a guess, confirm).
10. **Health ▸ Setup**: Check again, Test Claude (~$0.001), Re-auth from a row, stop Postgres and see the one error page, Report this. With the gateway, Slack and Org62 and devbar rows read ok.
11. **Distribution**: set `distributionDriveFolderId` / `distributionAnnounceChannel` (`config/team.json`, or the `distribution` settings key; no Settings page shows it) before the first `--publish`; confirm the devbar Drive read of `manifest.json` returns text; approve the announcement to a test channel once (one post); Copy upload instructions, then Mark uploaded. Run the `docs/INSTALL.md` prompt once with a teammate's Claude Code and Drive connector. Intel Mac and Gatekeeper on a Drive-downloaded `.tgz` were not run here.
12. **Outside the repo**: rename the row in `~/Projects/PORTS.md` (port 4327 unchanged), rename the Drive folder and, when you want, the Slack channel.

## 5. Final review (`16-wave34-review.md`, fbfa49f)

Verdict: **no blockers**. The invariants hold (the read allowlist is unchanged at 21 tools, the release announcement rides the D-56 relay as an Outbox decision, no credential text, port 4327, the state folder through one helper); the journal and snapshots are clean; one `npm run update` from a 1.3.0 checkout reaches the folder migration; nothing is destructive. All 14 asks scored done.

Fixed in the release pass:
- **W34-1 (M)** the worker could be left under the old LaunchAgent label when the migration was spawned by the web agent before the worker was bootstrapped, and missing after a reboot. Fixed: `finish()` starts every kind that has a new plist (db only when the bundled cluster exists), old labels are booted out last, the orphan guard in `run-service.mjs` exits when its env file sits under the vanished folder; race covered in `tests/ops/migrate-state-service.test.ts`, rule MG-14 in EDGE-CASES.
- **W34-2 (M)** five CHANGELOG lines did not match the code (sidebar groups, Settings groups, where the scan mode, routing and closing-engine switches live, the Needs provider count). Reworded (7f64af0). D-86's seven-item sidebar vs the two-group sidebar as built is a post-2.0 decision for you.
- **W34-3 (L)** CLAUDE.md invariant 1 now names the release announcement (D-90) among the Outbox decisions that may write.

Left for after 2.0 (owner `post-2.0` in the review): W34-4 a `BUG.READ_SCOPE_MISS` count in the doctor or Health; W34-5 `doctor --json` reading the migration marker; W34-6 `scan:private` names id-shaped text in 198 tracked files and 23 history commits (fixtures mostly): run it against the live database and push a fresh-history snapshot rather than this history, as README ▸ Sharing says.

## 6. Post-2.0 (2026-11-21, same release)

Draft by `post-docs-coherence-2` for the orchestrator; the numbers in the table below are left as `_` until the final tree is run. After the release commit the build went on, on the same branch and under the same version (`2.0.0`, no tag): the chunks below, each in `CHUNKS.md` "Post-2.0". Two lanes were still landing when this was written: `post-onboarding-dry-run` (20) and `post-a11y` (30); their lines are added when they integrate.

### 6.1 What landed

Before the first docs pass (`23-docs-coherence.md`):
- `post-scope-miss-and-marker`: `data:read-scopes` and `setup:state-folder` in the doctor and Health ▸ Setup (W34-4, W34-5).
- `post-sample-data-adapters`: the sample's tool adapter rows are valid; one invalid row is skipped with `DATA.ROW_INVALID`.
- `post-reopen-undo-carrier`: **Undo reopen** in "Why is this still open?".
- `post-security-review`: `17-security-review.md`; SEC-1..5 fixed (SEC-6 by its own chunk, SEC-7 is yours).
- `post-ui-polish-pass`: `18-ui-polish.md`; plain words on every page, Respond "+N more", the Settings grid.
- `post-read-twins-unify`, `post-work-items-view`: no read twins left (`19-read-twins.md`).
- `post-home-sql`: Home and Today read shared data once per request; migration 0037.
- `post-work-list-scope`: the Work list's `work` scope, tab counts in SQL, Closed paged.
- `post-assistant-evals`: Assistant goldens (routing, tool choice, D-100 safety, injection); router inputs on both DataSources.
- `post-sec-6-autopilot-hosts`: VDP autopilot adds asset links only from trusted sites (D-60 amended).
- `post-ui-leftovers`: Home one column with the panel open, Activity's Needs you under the tabs, Work ▸ Closed "Show 50 more", Getting started counts five outcomes.
- `post-engines-barrel-fanout`: thin engine barrels (`21-engine-fanout.md`; the under-40 target is unreachable for leaves the mock uses).
- `post-docs-coherence`: the first docs pass (`23-docs-coherence.md`).

After it:
- `post-sec-lows`, `post-sec-lows-2`: SEC-8 (remember only on your words; the list with its source and Forget), SEC-9 (sign-in only when named), SEC-10 (Review prompt → Open in Claude everywhere), SEC-11, SEC-13.
- `post-findings-cleanup`: 23's code findings (first-scan estimate on Getting started, dead onboarding pieces deleted, Composer label, release-row words, sample-data rename, D-91 not built).
- `post-max-lines`, `post-small-followups`: the long files split into `<name>.<part>` siblings (`22-max-lines.md`); TodayView split; `seed.example.json` regenerated.
- `post-test-flakes`: unit and UI tests deterministic (fake timers, conditions); the feedback gate follows a symlinked `node_modules`.
- `post-memory-source`: migration 0038, the exact source of each remembered note.
- `post-visual-qa`, `post-qa-leftovers`: `24-visual-qa.md`; 21 + 7 findings fixed (focus return, Closed switcher, release rows, "usually about $A, up to $B", held refusals, "Prepared: review the prompt…").
- `post-lint-zero`, `post-layer-grandfather`, `post-last-grandfather`: the layer rule is an error with nothing grandfathered; lint 0 errors, 1 warning (`onboarding/steps.tsx`, the onboarding lane's).
- `review-25`, `post-review25-fixes`: `25-post20-review.md`; P25-1..11 fixed (P25-3, this CHANGELOG pass, here).
- `post-caps-audit`, `post-caps-ui`, `post-caps-ui-2`, `post-contract-bounds`, `post-soql-chunking`: `26-caps-audit.md`; 42 arbitrary caps paged, counted or lifted, then the UI and contract leftovers; the team SOQL chunked.
- `post-worker-followups`, `post-job-kinds`, `post-relay-holds`: every paid job on the spend governor (F-4), job kinds from the registry, one hold per relay job.
- `post-read-profile`: `27-read-profile.md`; scopes for Briefs, the thread list, Settings, Getting started (Agents in `post-caps-ui`); migration 0039; a statement budget per page.
- `post-crash-resume`: `28-crash-resume.md`; recovery at worker start, the database wait, disk full as a retry, Health rows; EDGE-CASES "Worker".
- `post-persona-qa`, `post-persona-leftovers`: `29-persona-qa.md`; every page as the Specialist AE; role titles, persona gates on VDP rows, "AEs I cover" SE-only, the AE seed overlay and `smoke:crawl --persona`.
- `post-docs-coherence-2`: this addendum, `32-docs-coherence-2.md`.
- `post-eval-goldens`: `31-eval-goldens.md`; Assistant goldens for the post-2.0 behaviours, both personas (evals 332 → 386); P31-0 (the reauth description) fixed, P31-1..3 to the router chunks.
- `post-router-fixes`: `31-eval-goldens.md` P31-1..3; a typed "continue" after a Steps-per-message stop keeps the model and continues the stopped answer (`RATE.CHAT.STEP_LIMIT`), `remember` is out of the act intent, and `search`, `fetch` and `run` are described per persona.
- `post-router-followups`: `31-eval-goldens.md` P31-F1..3; the continuation prompt names the Steps per message stop, the mock's "continue" reaches the runner, `plan`, `propose` and `help` are described per persona (evals 387).
- `post-agentic-booking`: `28-crash-resume.md` Remaining 4; the Agent SDK runner writes a `turn` row per model turn, so a run killed mid-query is booked once at the next start and its hold settled with what it cost (EDGE-CASES WK-15 OK for both runners).
- `post-help-persona`: `31-eval-goldens.md` P31-F4; help never serves a playbook the role lacks (no VDP playbook for an AE, the Deal Contribution one only when it is on); evals 390, routing 92/92.
- `review-33`, `post-review33-fixes`: `33-post20-review-2.md`; P33-1 (a retention horizon before AD 1 failed the nightly run: clamped, and a failing rule is a Health row), P33-2 (Retry on a Steps-per-message stop re-asked the question: it is Continue and continues), P33-3 (a relay continuation counted a failed lookup as done) fixed; P33-4 is a closeout step (§6.4).
- `post-build-engine-check`: the release build refuses to ship without the bundled Postgres engine (the morning's 27.5 MB tarball had none: the optional dependency was not installed), the smoke says which the release carries, `--check-engine`; RELEASING's numbers (about 137 MB, 449 MB unpacked).
- `post-a11y`: `30-a11y.md`; axe on 61 targets in both themes, 1,687 violating nodes → 6 with none new (the six are History's calendar days, named by their date on purpose) (`post-a11y-leftover` named the Getting started card by its content and added `npm run test:a11y`); a skip link, every control's name contains its visible label, Settings Row helpers read as the field's description, heading levels in order; UX.md "Keyboard and screen reader". `post-a11y-last` and `post-a11y-rescan` named Home's Do now buttons and Today's blocks by what they show and made the scanner finish (a fresh context per scan, bounded waits).
- `post-onboarding-dry-run` (stopped) and `post-onboarding-salvage`: `20-onboarding-dry-run.md`; every ops script reaches launchctl through one seam (`CC_LAUNCHCTL`), so a dry run never touches the real agents; the doctor's fixes in a compiled release are commands a person can paste; the install walk's fixes (the build found next to the script, the chip and `.tar` cases, a handed-in build copied not moved, a first run with no user counted as up, plain messages on a failed first install, stopped agents started on a repeat install, SEC-14). SEC-12, the `last_error_code` doctor check, the AE wording on the steps and INSTALL.md follow in `post-onboarding-followups`; the walk itself is recorded by `post-install-walk`.
- `post-relay-flake`, `post-claim-owner`, `post-claim-required`: a Postgres test that failed once under load led to the worker claiming only its own user's jobs (`claimJobs` owner filter, required; WK-16); `28-crash-resume.md` "Flake".
- `post-a11y-last`, `post-a11y-rescan`: Home's Do now buttons and Today's blocks named by what they show; the axe scanner's stall after the dark pass; `30-a11y.md`.
- `post-install-walk`, `post-install-fixes`, `post-install-walk-2`, `post-install-fixes-2`: the teammate's first install walked twice from the built tarball on a throwaway state dir with a fake launchctl (`20-onboarding-dry-run.md` §Walk, §Walk 2). Walk 1: the morning tarball crashed at `install.mjs` (built before the salvage) and the shell's `PORT` broke the health step; ON-13..22 fixed (env file wins, install waits for health, pasteable fixes and the real port, `/api/v1/version` before a user, the heartbeat during the no-user wait, true feed messages, the build refuses a symlinked `node_modules`). Walk 2: a teammate following INSTALL.md gets a running app on the default port; ON-23..27 (the shell's `PORT` written into a new env file and the health poll proving the process is ours, `/api/v1/health` before a user, `--reinstall`, truthful rollback lines).
- `review-34`, `post-review34-fixes`: `34-post20-review-3.md`; 0 blockers; P34-1 (the env-file-wins port rule in `update.mjs` and `setup.mjs` too), P34-3 (recovery books interrupted passes once under a per-run lock), P34-4 (no raw stack from `install.sh`), P34-5 (the step-limit code pinned equal).
- `post-scan-placeholders`: `scan:private` tells placeholder-shaped ids from real ones offline (P33-4).
- `review-35`, `post-review35-fixes`: `35-post20-review-4.md`; 0 blockers; a timed-out axe scan fails the run; the install's health poll requires the release's `instance` on a first install and on newer builds; the private scan's checksum rule only on mixed-case ids.
- `post-install-walk-3`, `post-install-fixes-3`: the first install walked a third time from the final tarball with `PORT` in the shell (a running app on that port, nothing on 4327); ON-28..32: the release build starts from a clean `.next` and checks the page's sha against the server's, clean restarts are not crashes and the doctor names a crash loop as one, the rollback hint only when the version differs, `install.mjs` refuses options it does not know.
- `post-install-doc-clarity`, `post-update-banner-prompt`, `post-update-prompt-path`: INSTALL.md for a teammate who has never opened Terminal, every message quoted from the code; the Health update banner on an installed copy copies the Drive + `--from` prompt (a checkout keeps `npm run update`); that prompt honours `CC_STATE_DIR` and is pinned equal to the ops script's.

### 6.2 New migrations

0037 (`drafts_owner_canvas_idx`, Home), 0038 (`chat_memory.source_message_id`, nullable uuid, no backfill), 0039 (`source_items_owner_first_seen_idx`). All additive; with them the release applies **0027–0039** on `npm run update` (§2 ask 13 said 0027–0036).

### 6.3 New manual checks on the work machine

Run after §4 step 4 (the upgrade). Each was tested here with fakes or the mock only.

- **Database.** `psql` → `\d chat_memory` shows `source_message_id uuid`; `\di drafts_owner_canvas_idx` and `\di source_items_owner_first_seen_idx` exist. `DATABASE_URL=<app db> npm run db:read-profile -- --route all --runs 7 --compare` (counts only): no page repeats a statement (`--dupes`), Briefs, Settings, Getting started and Agents in tens of statements, not about 60.
- **Assistant** (`CC_CHAT_LLM=1`). "from now on I log in 15-minute steps" → kept; "summarise my unread mail" → no sign-in window, no preference kept, a neutral "Not kept" or "Sign-in not started" row (no red ✕); "sign me in to gmail again" → the sign-in starts. A planted `![](https://example.invalid/x)` in a Slack message it summarises, and an answer asked to contain `![x](https://example.com/p.png)`: the alt text shows and the browser's network panel has no request to either host. An expanded Slack or Gmail tool row says "others' words". Steps per message set to a small number: the answer stops and names Settings ▸ Budgets ▸ Assistant limits.
- **Settings ▸ Budgets ▸ What the Assistant remembers.** The preference above, with its source message ("from your message in …"); Forget, then Forget for good; focus lands on the next entry.
- **Review prompt → Open in Claude.** On Agents (a queued run and the header's Start in Claude), Home (a card and Coming builds), Today, the Details panel and the Assistant's session card and thread pane: the whole prompt and "runs with your permissions" first; nothing opens until Open in Claude; Agents reads "Prepared: review the prompt, then click Open in Claude" meanwhile; Not now returns focus. A running session still opens on one click.
- **Work.** Closed: "Show 50 more · N of M shown"; close or reopen an item between two pages and no row repeats or goes missing.
- **Home and Activity.** Home is one column with the Details panel open at 1440; Activity's "Needs you here" is the first section under the tabs, and its header reads "N rows and M use cases (K to add) need you".
- **Getting started.** "1 of 5" (an AE: four, the week is "Update your forecast notes"); before the first scan ends, "First scan: usually about $A, up to $B, about N h. Past that it asks before it goes on."
- **Health.** Ledger: "Show 100 more · N of M runs loaded" reaches the oldest run. Spend: "usually about $A, up to $B a day", no p50/p90. After a day of real scans, the worker log's `BUG.PROMPT_CUT` lines (caps audit F-12) say which prompt counts the token trimmer could take over.
- **Spend asks from background jobs** (F-4). With a small daily budget, a read-in or Find assets run asks on Health ▸ needs you instead of failing, and Allow $X more continues it; `org62.discover` and `accounts.hierarchy` each show one hold and at most one ask in Health ▸ Spend; the team read returns every covered AE's opps through the one-call path (a large covered-AE list goes in several statements).
- **Crash and resume.** While Health shows a scan running: `launchctl kill SIGKILL gui/$UID/com.commandcenter.worker`; within a minute "<scope>: a scan stopped when the app closed; it picks up where it left off.", and "picked up" after its next scan. Then `launchctl kill SIGTERM gui/$UID/com.commandcenter.db` and restart the worker: `worker.heartbeat` stays `starting` with `"last_error_code":"DEP.DB.DOWN"` and no crash-loop row; start the database and the worker writes "The database was not answering … waited …".
- **Specialist AE.** On a test install (or after a backup), Settings ▸ Role & rules ▸ Specialist AE: the Role row reads "Specialist AE" once; Settings ▸ Sending has no VDP autopilot rows, Connectors no VDP re-auth block, Profile & hours and Time no "AEs I cover"; Health ▸ Setup has no VDP row; Activity opens on Forecast. Switch back to SE and every one returns.
- **VDP autopilot** (SE). An asset link on an unlisted host is held with "Held for you: link is on <host>, not a trusted site"; a listed host applies within the daily cap. Add and remove a trusted site in Settings ▸ Sending (focus stays in the list).
- **Release rows.** With no `distributionAnnounceChannel`, the announcement's row says what to set once and its Details panel reads "Set up first" with Apply off; the upload is listed above the announcement.
- **Release build** (maintainer). With a throwaway `.env` containing `X=1` in the checkout, `npm run build:release`, then `tar -tzf dist/command-center-*.tgz | grep -c '\.env'` is 0. `npm run scan:private` (with the database) before any push. The build prints `[build:release] engine: @embedded-postgres/darwin-<arch> <version> (initdb, pg_ctl, postgres)` before `next build`, and `--smoke` prints `[smoke] engine: … bundled (initdb, pg_ctl, postgres)`; `npm run build:release -- --check-engine` checks the engine alone.
- **Steps per message** (`CC_CHAT_LLM=1`). Settings ▸ Budgets ▸ Assistant limits, Steps per message 1; ask something that needs several tools: the stop card's button reads Continue, and clicking it (or typing "continue") goes on with the stopped answer in the same model, with no second question and no second charge for the first steps in Health ▸ Spend.
- **Settings ▸ Data.** A horizon of 5,000,000 days, then Run retention now (dry): it plans without an error.
- **Health ▸ Scans.** "Older" pages to the oldest run; with a scan finishing between two pages, no run repeats or goes missing (as Work ▸ Closed above).
- **Relay asks** (F-4). With a small daily budget, an Org62 discovery or readback asks on Health ▸ needs you; Allow $X more runs one continuation on the same hold, and Stop cancels it.
- **Agentic crash** (`post-agentic-booking`). While an agentic scan is in a model session: `launchctl kill SIGKILL gui/$UID/com.commandcenter.worker`; after the restart, that run's `llm_calls` rows have outcome `interrupted`, its hold is `abandoned` with their sum, and a second restart books nothing more.
- **Help per role** (`CC_CHAT_LLM=1`). As a Specialist AE, "how do I update a VDP?" answers that VDP is not active for your role (Settings ▸ Role & rules lists it); as an SE it gives the VDP playbook.
- **Questions for system owners** (caps audit F-11): whether VDP or Org62 limit a use case's products (6) and a company's aliases (20 in the judge, 50 in identity); then name the limit in a comment or lift it.
- **Update with `PORT` in the shell** (P34-1). `PORT=4999 npm run update -- --from <tgz>` on a throwaway state dir: the health poll uses the env file's port, and the update does not roll a good release back.
- **First install with `PORT` in the shell** (ON-23). A throwaway `CC_STATE_DIR` and `PORT=4999`: the new env file says `PORT=4999`, the app answers there, and "Open http://localhost:4999" is printed.
- **Another app on the port** (ON-23, P35-2). With something else answering `/api/v1/version` on the install's port, `npm run ops:install` fails with "another app answers on port <p> … lsof -i :<p>" and rolls back; it never reports success on a reply without the release's `instance`.
- **Axe run** (P35-1). `npm run test:a11y -- --port <p>` against a mock production build ends with a summary line; a page that times out is a failure (exit 1), never a silent skip.

### 6.4 Still yours

SEC-7 (sign the release feed) is yours; SEC-12 and SEC-14 are done (`df74398`, `2cb9011`; review 34 P34-2). D-86's seven-item sidebar is your decision. Before the push, run the DB-backed `npm run scan:private` and record what it found (counts only): the no-database pass names 201 tracked files with id-shaped placeholders (sample data and test fixtures, P33-4), so only the database pass tells a real id from a placeholder. Then push a fresh-history snapshot, not this history, as README ▸ Sharing says (W34-6). The "Known noise" paragraph in §1 no longer applies: the doctor test and the feedback gate are deterministic (`post-test-flakes`). The offline `npm run scan:private -- --no-db --no-history` is a pre-filter (placeholder-shaped ids are set aside; 4 files remain to look at); the DB-backed run is the gate.

### 6.5 Verification on the final tree

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors (a6fdba5, the final tree) |
| `npm run lint` | 0 errors, 0 warnings |
| `npm test` (unit + ui) | 519 files, 5,044 passed, 11 skipped |
| `npm run test:db` (fresh databases) | 93 files, 1,052 passed, 6 skipped (a6fdba5) |
| `npm run test:evals` | 8 files, 390 passed, 1 skipped |
| `npm run smoke:crawl -- --mock --persona se` / `--persona ae` | 43 / 43 pages, no console or page errors |
| `npm run build:release -- --smoke` | `dist/command-center-2.0.0-arm64.tgz`, 137.5 MB (449 MB and 13,619 files unpacked, the Postgres engine bundled), sha256 `81ffebdc4bce822c1d296b6957eedd0dfb1f4eeb99fbb5c12c0bd4bca01331c7` (built from a6fdba5 after a clean `.next`); web `GET /` 200, `/api/v1/version` v2.0.0; worker migrated and heartbeat, waiting for onboarding, exit 0 |
