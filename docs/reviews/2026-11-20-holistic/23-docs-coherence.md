# 23 · Docs coherence after the post-release chunks (post-2.0, 2026-11-21)

Builder `post-docs-coherence` (Opus), on `tmart2322/control-center-port-polish` at `e9e5c26`. Method: every claim in
the living docs and in CHANGELOG `## [2.0.0]` that touches what changed since `117e675` (`git diff --stat
117e675..HEAD`: 300 files), plus the older lines that the same reading showed to be wrong, checked against the code
(file and line, not the review reports). Where the code contradicts a doc, the doc was fixed. Where a doc states a rule
that the code breaks, the code is listed below for the orchestrator and was not changed. No source file was edited.
The mock app was not started: every claim here was checked by reading code and tests, not by screenshots.

## What was wrong, per doc

Counts: **corrected** claims (the doc said something the code contradicts) + **added** (the doc was silent on a shipped behaviour it covers).

| Doc | Corrected | Added | What |
|---|---|---|---|
| `CHANGELOG.md` 2.0.0 | 9 | 24 | Existing lines: migrations "0027–0036" (0037 shipped); "Settings ▸ Budgets ▸ Routing" and "▸ Ranking" (the section is **Models and ranking**: Assistant model, Ranking) and the closing engine's place (Sending ▸ **Closing items for you**); Home briefing cited **D-93** (it is D-86); the Needs-you list named "replies, follow-ups, Org62 mismatches" (none is a kind: the eleven `NeedKind`s are listed now); fetch-then-interpret named Gmail, Drive, Notes **and Claude sessions** as fetched "through one MCP call" (Slack and Org62 go through the relay, Gmail/Drive/notes through the Google client, and Claude sessions, Calendar, VDP, watch briefs and Org62 `book`/`missed_opps` stay agentic: `src/scanner/runtime/mode.ts:5`, `fti-specs.ts:47`); "**the worker** binds to loopback" (the web does; the worker listens on nothing); "ADRs 0088–0101" (0076–0101 and 0060); Assistant v2 cited only D-100 (routing and sessions are D-81); "the Org62 canvas row" (plain words: the next logging batch). Added: Undo reopen, two Setup rows, Work ▸ Closed paging, trusted sites, Assistant goldens; Getting started's five outcomes, plain words, pages making room, routing on your own words, Home/Today/Work reads, no read twins and thin barrels; six Fixed lines; a **Security** subsection for SEC-1..6 plus the untrusted marker and the quoted-paste act rule |
| `docs/UX.md` | 11 | 4 | "Why is this still open?" said "no buttons" (Undo reopen is there now) and "shadow mode (the 1.x default)"; Activity's "Needs you here" was "on Log it and Needs you" (it is the first section under To log's tabs, in the scroll); Respond ended at "Review N in the Outbox" (it says "+N more", then "+N more on Work"); the Views table said 1.3.x; the Assistant model menu's path; the composer offered "Push as Slack/Gmail draft" and "Schedule" (Draft / Send toggle, "Save as Slack draft"; no Schedule control); the Health ▸ Setup code list named the unmounted `Outcomes.tsx` and `health-outcomes.ts`; the update banner was on "Health and Getting started" (Health only now); **Getting started = five outcomes** described the unmounted set (See my asks · Know my day · Log my time · Keep VDP current · Ask the Assistant): rewritten to `OUTCOMES` in `src/guide/checklist.ts` (sources · role · draft · week · DC); the Ranking path. Added: narrow Home (R11), the State folder and Page reads Setup rows, the trusted-sites row under VDP autopilot, the Settings grid below 1,360 px |
| `README.md` | 15 | 0 | "waits in the Outbox, or on Time" (Activity); Homebrew Postgres listed for everyone (source only; the compiled build brings its own, D-98) and "you still need the prerequisites except git and npm"; four Settings paths (Me ▸ Role & rules, Data ▸ About twice, Sending ▸ Feedback); Getting started listed the old seven steps; `DEP.DB.DOWN` said `brew services start` (the catalog: `launchctl kickstart … com.commandcenter.db`); `update` options lacked `--unverified`; `--from` "checks the sha256 against the manifest next to it" (it refuses when no feed lists the file, SEC-3); "an install from before 1.3.1" (there was no 1.3.1); backups "the newest 7" (7 daily + 4 weekly, base backups for the bundled cluster); restore into `control_center_restore` (`<db>_restore`, so `command_center_restore`, or a copy cluster for a base backup); "the oldest backup kept (7 nights)"; Development's `npm run check` as the everyday command (it needs Postgres; `check:fast` is the loop) |
| `docs/ARCHITECTURE.md` | 10 | 2 | Header "as built (1.3.x)" and "As built (1.4" (2.0); mock mode "planned: retired onto PGlite" (did not ship); retention "planned" (built); the engines table lacked resolution, attribution, use cases and needs and listed three of them as "planned, phase 2"; §6 said the app sends "Slack and Gmail drafts and sends" (the live transport fails closed for both: `src/outbox/transport.ts:4-7`) and left out autopilot and the release announcement; §7 still had the spend governor and the error catalog "planned" and "three classifiers overlap"; §10 said the installer fetches the VDP cookie script pinned (D-91 is not built); "Today: git clone…" (that is the source path). Added: §8 SEC-4/5/1 and the untrusted marker; §10 SEC-2/3 and the unsigned feed (SEC-7); §5 the thin-barrel rule |
| `docs/DECISIONS.md` | 14 | 0 | Status column: D-77 "planned" (amended by D-98); D-78, D-79, D-80, D-81, D-84, D-87, D-90 "planned" (built); D-82, D-83 "partly built" (built, shadow by default); D-86 "planned" (partly built: no seven-item sidebar); D-88, D-92, D-93 statuses said what is left. Every ADR file has a row and every row with a file links it (0060, 0076–0101) |
| `docs/decisions/*.md` | 13 | 0 | Status lines only, each with an "as of 2.0 (2026-11-21)" suffix (the decision text is untouched; every file still ≤ 30 lines): 0077–0084, 0086–0088, 0092, 0093 |
| `docs/README.md` | 2 | 3 | "97 decisions, D-76..D-97 as files" (101; D-60 has a file); the reviews row pointed only at the holistic README. Added: `INSTALL.md`, `CONNECTORS.md`, `DATA-MIGRATIONS.md` (all three were missing from the index), the 2026-11-13 audit, and a holistic-review table with one line per report 13–23 (plus 00–12, BUILD-BRIEF, CHUNKS, STATUS-2.0; there is no 20) |
| `CLAUDE.md` | 1 | 2 | "`npm run check` (typecheck + lint + test)" (it is `check:fast` + `test:db` + `test:evals`). Added: autopilot's asset links only from trusted sites in invariant 1; a Sample DB row (`sample:load`, `sample:validate`, `sample:lint`) |
| `CONTRIBUTING.md` | 1 | 0 | "The 11 files over 1,000 are grandfathered" (9 in `LONG_FILES_GRANDFATHERED` today, and `post-max-lines` is shrinking it): the count is gone, the list is named |
| `AGENTS.md` | 0 | 0 | Accurate (see process note below) |
| `docs/EDGE-CASES.md` | 0 | 0 | The post-release rows (VD-36, MG-14, RD-4, RD-6, CR-01) match the code they cite (`asset-hosts.ts`, `migrate-state.mjs`, `checks/data.ts`, `reads/work-list.ts`, `why-open.tsx`) |
| `docs/TENETS.md` | 0 | 0 | Every tenet the living docs cite is quoted by its name |

## Code findings for the orchestrator (not changed here)

1. **Dead file: `src/components/onboarding/Outcomes.tsx`** (and `src/client/health-outcomes.ts`, their tests
   `src/components/onboarding/__tests__/outcomes.dom.test.ts`, `src/client/health-outcomes.test.ts`, and the export at
   `src/components/onboarding/index.ts:5`). Nothing mounts `GettingStartedOutcomes`; `/getting-started` renders
   `src/guide/GettingStartedPage.tsx` over `OUTCOMES` (`src/guide/checklist.ts:341`). It describes the other five
   outcomes (See my asks · Know my day · …) that UX.md used to list. Two things lived only there and are now on no page:
   the first scan's estimate with **Start** (`firstScanEstimateLine`, `Outcomes.tsx:23`) and the update banner on
   Getting started (`UpdateBanner`, now only in `HealthPage.tsx`). Delete the file set, or carry those two pieces over.
   **Fixed (24287d9, post-findings-cleanup).** The estimate is carried over: UX.md ("Raise a hand") specifies it on Getting started, so Connect your sources shows "First scan: about $A–$B (p50–p90), about N h. Past that it asks before it goes on." for the lookback chosen in setup until the first scan is done (`GettingStartedPage.tsx`, ui test). No Start button: Getting started is behind the onboarding gate, so the first scan is always requested already (onboarding's Start first scan), and no route starts it again; the step's own button (Open Health / See progress) stays. The update banner is not carried: UX.md specifies it on Health only, where it is mounted. The dead file set and its export are deleted.
2. **"Push" is still the composer toggle's accessible name**: `src/components/composer/Composer.tsx:697`
   `label="Push as a draft or send"`, against UX.md "Plain words on every page" (never "push" for a draft). A screen
   reader says it; the visible labels are fine. **Fixed (24287d9):** "Save as a draft or send" (a one-string edit; Composer.tsx has a max-lines warning and its line count is unchanged; no test asserted the old label).
3. **User text names a Settings section that does not exist**: `src/outbox/adapters/release-handoff.ts:108,156`
   ("Settings ▸ distribution driveFolderId", "distribution.driveFolderId is not set"). Settings has no distribution
   section (`src/components/settings/derive.ts:180-236`), and 17-security-review SEC-5 notes it is not a
   `patchSettings` section. UX.md ("Release rows") and EDGE-CASES RL-04 repeat the code's words, so they were left as
   they are until the code says where to set it (config/team.json is the one place a user can). **Fixed (24287d9):** the strings name `distributionDriveFolderId` / `distributionAnnounceChannel` in config/team.json; `tests/outbox/release-items.test.ts` pins it. UX.md "Release rows" and EDGE-CASES RL-04 still repeat the old words: left (outside the cleanup glob).
4. **D-91 is not built**: no installer step fetches the VDP cookie script (`scripts/ops/install.sh`,
   `install.mjs`: no reference; `setup.mjs:282` only prints the command). `p4-compiled-build-distribution`'s scope
   listed it. ARCHITECTURE said it was built; it now says planned. **Left, recorded (24287d9):** not built; D-91's Status and its DECISIONS.md row say "not built as of 2.0; the Re-auth VDP button and docs/INSTALL.md cover it".
5. **Two code comments name the old restore database**: `scripts/ops/restore.mjs:3,7` (`control_center_restore`); the
   default is `${db}_restore` (`:26`), so `command_center_restore`. **Left** to the onboarding/ops builders (owners of `scripts/ops/**`).
6. **`sample-data/README.md` and `sample-data/BRIEF.md` still say "Control Center"**: outside `rename-grep`'s scan
   dirs, so the test does not see them. Low; the sample-data owner's call. **Fixed (24287d9):** README and BRIEF say Command Center (the BRIEF's state folder is `command-center/`, `control-center/` on 1.x); `rename-grep` now scans `sample-data/**/*.md`, treating markdown table rows there as world data (the fictional user's repo is named control-center in `tables/*.json`). The sample DB names (`control_center_sample`) were left: `scripts/sample-data/validate.ts` uses the same name and the old-name grep does not cover underscores.
7. **D-86's sidebar count is still Tristan's open decision** (18-ui-polish, cross-cutting): seven counts in the
   sidebar, Today's among them. Docs describe what ships (two groups, several counts). **Left:** Tristan's decision.
8. **Process, not code:** `AGENTS.md` and `CLAUDE.md` give lane ports 4345–4360, while the post-2.0 briefs assign
   4385–4397. Either widen the documented range or keep briefs inside it. **Fixed (23a254d, the orchestrator):** AGENTS.md and CLAUDE.md give lane ports 4345-4399.
9. **A review report disagrees with the code it reports on**: 18-ui-polish says Getting started's sentence reads
   "4 tick themselves …; the deal contribution is yours to claim". The code says "Each one ticks itself from what you
   actually did" (`src/components/onboarding/started-sentence.ts`). The living docs follow the code. Reports are
   history, so it was not edited. **Fixed (24287d9):** 18-ui-polish now quotes the real sentence, marked as corrected.

## What I could not verify

- **Live behaviour**: Slack/Gmail delivery (fail-closed per `transport.ts`), Drive update checks, the 1.x move on a
  real install, autopilot against VDP. All of it was read from code and tests only.
- **Visual claims** (layout at 1440, the narrow Home, the Settings grid): read from CSS and DOM tests, not screenshots.
  The lane port was not used.
- **Files owned by other builders**: `docs/INSTALL.md`, `docs/reference/OPS.md` (the onboarding dry run) and the
  max-lines split (`22-max-lines.md`, the grandfather list) were not read for accuracy. `docs/RELEASING.md` is outside
  this glob: SEC-3 says it was updated for `--unverified`, and that was not checked.
- **The reference specs** (`docs/reference/*`) were not swept. `docs/README.md` already says the code and the living
  docs win over them.
- **CHANGELOG lines W34-2 already verified** (sidebar groups, Settings groups, `CC_SCAN_MODE`, provider count) were
  checked again and hold. The remaining older lines (Upgrading's 1.x flow, retention numbers, the side-car columns)
  were spot-checked against their scripts (`migrate-state.mjs --check`, `run-service.mjs` `migrate.log`,
  `backup.mjs` 7 + 4, `db:backfill --dry`). They were not re-run.
