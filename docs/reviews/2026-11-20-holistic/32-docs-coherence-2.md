# 32 · Docs coherence, second pass (post-2.0, 2026-11-21)

Builder `post-docs-coherence-2` (Opus), on `tmart2322/control-center-port-polish` at `aee02a5` (after the relay-holds
merge, `198bcf1`). Method as in [23](23-docs-coherence.md): every living-doc claim that the chunks since `a59f73d` touch
(171 commits under `src`, `app`, `scripts`; reports 22 and 24–29, the CHUNKS rows after `post-docs-coherence`) was
checked against the code by file and line, not against the reports. A doc the code contradicts was fixed in the doc. A
doc rule the code breaks is listed below and was not changed. No source file was edited. The mock app was not started.
Three lanes were still landing (onboarding dry run, accessibility, eval goldens): no line was written for their work,
and `docs/INSTALL.md`, `docs/reference/OPS.md` and UX.md's keyboard section were not touched.

## What was wrong, per doc

**Corrected** = the doc said something the code contradicts. **Added** = the doc was silent on a shipped behaviour it covers.

| Doc | Corrected | Added | What |
|---|---|---|---|
| `CHANGELOG.md` 2.0.0 | 2 | 35 | "Migrations 0027–0037" (0039 shipped); "every search and fetch result is marked untrusted" (query and read too, P25-5). Added (P25-3): **Added** 5 (What the Assistant remembers, Review prompt → Open in Claude, Ledger paging, the first-scan cost on Getting started, crash recovery), **Changed** 8 (every paid job asks, F-4; no arbitrary caps; Steps per message; estimates in words; page reads; the Specialist AE's app; tool rows; the AE's Getting started week), **Fixed** 7 (keyset Closed cursor and the Closed switcher; team SOQL; "Prepared: review the prompt…"; release rows; Activity and prep words; focus return; crash cases), **Security** 6 (SEC-8, 9, 10, 11, 13 and the shared forbid list), a new **Engineering** subsection (the old Added bullet moved there, plus 8: layer rule an error, file splits, deterministic tests, crash drills, job kinds, read budgets, persona crawl, load/usage guards), **Removed** 1 (dead code). Every existing line re-read against the code: they hold (`CHAT_TOOLS`, `PAGE_SIZE` 50, the doctor ids `setup:state-folder` / `data:read-scopes`, 0037's one index, the trusted-site defaults and "Held for you" words in `asset-hosts.ts`). |
| `docs/ARCHITECTURE.md` | 5 | 7 | §2 "lint warnings for now, violations grandfathered" (an error, `LAYER_GRANDFATHERED` empty); §2's "known edges" list (none is left: no engine, persona, projection, lib or contract file imports `@/llm`, `@/db`, `@/worker`, `@/server` by value, and `calendar.ts` reads `@/lib/event-titles`); §7 "relay lookups hold per call" (only outside a job; inside one they book into its hold); `tests/jobs/job-kinds.test.ts` (it is `tests/hygiene/job-kinds.test.ts`); "steps are a runaway guard only (200)" (any positive number in Settings ▸ Budgets ▸ Assistant limits; research turns are the same 200 guard, `RESEARCH_RUNAWAY_TURNS`). Added: the ports and `src/lib` moves and the voice CLI (§2); 27, 0039 and the Ledger keyset cursor (§4); `remember` (SEC-8, 0038, the Settings list and its routes, `held`) and `run reauth` (SEC-9) in the tool list (§7); §8 SEC-10, SEC-11, SEC-13 / P25-7 and the one forbid list |
| `docs/UX.md` (not the keyboard section) | 3 | 2 | Settings ▸ Me's "AEs I cover" slot and Settings ▸ Time ▸ AEs I cover were for every role (SE only: `org62Book === 'team_member'`, `SectionExtras.tsx:20`, `TimeSection.tsx:160`); Sending's VDP autopilot and Connectors' VDP re-auth block likewise (behind `PersonaGate`). Added: "Prepared: review the prompt…" and focus return in the Review-prompt paragraph; Health's crash and outage rows |
| `README.md` | 1 | 1 | "`ops:rollback` goes back to the previous build." twice. Added: the Assistant keeps a preference only when asked, Settings ▸ Budgets lists it, and a prepared session opens only after Review prompt |
| `docs/EDGE-CASES.md` | 2 | 0 | WK-15 said the FTI runner writes its `pass` rows when the run ends (each call flushes as it returns since 0782e1a; the agentic runner's gap stays); RL-04 quoted "Not sent: no announcement channel set …" (the refusal points at the row: `release-handoff.ts:161-162`) and the "said once", "Set up first" behaviour |
| `docs/DATA-MIGRATIONS.md` | 2 | 1 | The side-car ADR linked as "D-98 … 0098-sidecar-to-columns.md" (D-99, `0099-…`); "schema mechanics are in CONTRIBUTING 'Migrations'" (CONTRIBUTING has the rules; the mechanics are this file's "Writing the next one"). Added: 0037–0039 are step 1 only |
| `docs/DECISIONS.md` | 1 | 2 | D-93 "partly built (layer lint still warns, files grandfathered)" → built. D-80 and D-100 status gain what the post-2.0 chunks built (F-4; the own-words test on `remember` and `run reauth`) |
| `docs/decisions/*.md` | 0 | 3 | Status lines only, "as of the post-2.0 chunks": 0080, 0093, 0100 (each still ≤ 30 lines) |
| `CONTRIBUTING.md` | 1 | 1 | The Infra row's Lint ✓ (only `connectors` has a rule: "✓ (connectors)", as ARCHITECTURE says). Added: `smoke:crawl --persona se\|ae` and the AE seed overlay |
| `CLAUDE.md` | 0 | 2 | Command rows for the smoke crawl (with `--persona`) and `db:read-profile` |
| `AGENTS.md` | 0 | 0 | Accurate: lane ports 4345–4399, `load:guard` and `usage:guard` match `scripts/dev/*.mjs` |
| `docs/README.md` | 2 | 10 | "There is no report 20" (the onboarding dry run's 20 is in progress); 22 "in progress when this index was written" (done). Added: 20, 24–32 (20, 30, 31 marked in progress, unlinked until they land) and STATUS-2.0's addendum |
| `STATUS-2.0.md` | 1 | §6 | §4.11 said the distribution ids can be set "in Settings" (there is a `distribution` settings key and no Settings page). Added §6 "Post-2.0 (2026-11-21, same release)": what landed (one line per chunk, grouped before and after the first docs pass), migrations 0037–0039 (0027–0039 in all), 15 groups of manual checks deduplicated from 17, 24–29 and 25's list, what stays the owner's, and the verification table with `_` for the orchestrator |

## Code findings (not changed here)

1. **Comments name a Settings page that does not exist**: `src/outbox/transport.ts:17` and `src/outbox/release.ts:11`
   ("Settings ▸ distribution"), `src/outbox/adapters/release-handoff.ts:151` ("the `settings.distribution` row").
   There is a `distribution` key in the settings contract (`src/contract/settings.ts:648`), but no Settings section shows
   it; the user-facing strings already say config/team.json. Words only.
2. **A shipped migration's comment says "Settings ▸ Assistant"**: `src/db/migrations/0038_memory_source.sql:2`; the list
   is Settings ▸ Budgets ▸ What the Assistant remembers. Never edit a shipped migration (D-96): note only.
3. **Doctor does not read the worker's wait for the database** (EDGE-CASES WK-14, still GAP):
   `src/ops/checks/heartbeat.ts` has no `last_error_code` branch; the exact change is 28-crash-resume.md "Remaining 2"
   (onboarding lane's file).
4. **The agentic runner books a killed query's calls nowhere** (WK-15, now "OK for FTI, GAP for agentic"):
   `AgentSdkSkillRunner` traces one `pass` row per SDK query when it ends (28 "Remaining 4").
5. **Two reports cite a test path that moved**: 26-caps-audit.md F-4 and 28-crash-resume.md cite
   `tests/jobs/job-kinds.test.ts`; the file is `tests/hygiene/job-kinds.test.ts`. Reports are history; ARCHITECTURE now
   names the real path.
6. **No doc rule found broken by the code.** Checked: the layer rule (no value import across the table, lint 0 errors),
   max-lines (0 over 1,000, one 600-line warning in `src/components/onboarding/steps.tsx`, 677 lines: a warning, as the
   rule allows), both grandfather lists empty (`eslint.config.mjs:65-75`).

## What I could not verify

- **Live behaviour**: the sign-in gate on real phrasing, Review prompt with a real Claude Desktop, the crash drill on
  LaunchAgents, relay holds against real Org62 and VDP lookups, the team SOQL through the one-call path. Read from code
  and tests only; each is a manual check in STATUS-2.0 §6.3.
- **Visual claims** (focus return, "Set up first" pill, Home one column, the persona gates on screen): read from the
  components and their DOM tests (`release-missing.dom.test.ts`, `settings-page.dom.test.ts`, …), not screenshots.
- **Numbers**: the verification table is left as `_`. The only command run for numbers: `npm run lint` on `aee02a5`,
  0 errors and 1 warning (`steps.tsx` max-lines).
- **Files owned by the running lanes**: `docs/INSTALL.md`, `docs/reference/OPS.md`, UX.md's keyboard section, and
  reports 20, 30, 31 were not read for accuracy.
- **The reference specs** (`docs/reference/*`) and `docs/RELEASING.md` were not swept.
- **Manual-check sources**: reports 24, 26, 27 and 29 have no "manual checks" section; their live checks were taken from
  each report's text, and builders' returns that are not in a report were not seen.
