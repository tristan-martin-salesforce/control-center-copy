# 29 · Persona QA: the Specialist AE, then the SE's persona branches (2026-11-21)

Builder `post-persona-qa`. Base `tmart2322/control-center-port-polish` at `f912b83`. Mock mode on lane port 4414
(`CC_DATA=mock`, the placeholder seed). Every page below was shot at 1440 in dark and light (`?theme=`) with a
Playwright walk that also saved each page's text, and the onboarding steps were driven click by click. Judged against
D-55 (personas preconfigure, an inactive feature or source has no daily surface), UX.md's persona lines, TENETS and the
24-visual-qa method.

Shots (git-ignored): `.shots/persona-qa/` in the worktree. `ae-before/` (the AE before any fix), `ae-after/` (the AE
after the first fixes), `ae-final/` (the fixed surfaces at the end), `se-after/` (the SE), `ae-onboarding/` and
`se-onboarding/` (`onboarding-step1..6`). Names `<route-slug>-<dark|light>.png`.

Severity as in 18: **H** wrong idea or can't read it · **M** jargon, a surface the role doesn't have, misleading
state · **L** cosmetic.

## How to be the Specialist AE in the mock

There is no `CC_PERSONA`. The persona is Settings ▸ Role & rules (the `persona` settings section), and the mock keeps it
in memory:

- **In the app:** Settings ▸ Role & rules ▸ Specialist AE ▸ Save (or onboarding's Role step).
- **From a script:** `PATCH /api/v1/settings/persona {"ifVersion": <persona.version>, "value": {"id": "ae"}}`. This is
  what the page does: it also reseeds the AE starter policy and reranks.
- **Crawl:** `npm run smoke:crawl -- --mock --port <p> --persona ae` (added here, `d6fe5fe`).
- **Caveat found on the way:** `next dev` restarts itself when it nears its memory threshold ("Server is approaching
  the used memory threshold, restarting...", three times in this session); the mock store reloads from the seed and the
  persona goes back to SE silently. The crawl's `--persona` re-asserts it before every page. For a long walk, a seed
  copy with `settings.persona.id = "ae"` passed as `CC_SEED_PATH` keeps the AE through a restart (the policy stays the
  seed's SE one until a switch). Nothing in `src/mock/**` was changed.

## Totals

| Severity | Found | Fixed | Left |
|---|---|---|---|
| H | 0 | 0 | 0 |
| M | 13 | 13 | 0 (the last three fixed by `post-persona-leftovers`) |
| L | 8 | 3 | 5 (the onboarding lane's file, or right as is; the AE seed fixed by `post-persona-leftovers`) |

## Specialist AE, page by page

| Page | What I saw | Sev | Status |
|---|---|---|---|
| **Home** | Log & fix leads with the AE's duties: "3 forecast notes due Mon · Biggest first: Globex, ACME, Hooli · Draft notes", "2 deal roles to set · Deal Role None on $890k ACV", "1 opp with no Specialist Forecast". No DC or missed-opp rows, no VDP re-auth line. Sources "6/7". | – | Correct (built server-side, `src/engines/home`). |
| Home | The Admin row reads "Admin: 4 items · trainings, log time, VDP": the AE preset's admin classes include a `vdp` title class, and the seed has a VDP-titled task. | L | Left: the class is in `src/personas/ae.ts` on purpose (an AE may activate VDP); an AE without VDP rarely has such a task outside the SE seed. |
| Home / Today / Work / Assistant / Briefs | Every item, meeting and brief is the seed's SE world: "ACME Phase 2 demo", "SE team stand-up", "Kick off the demo-org build", the morning brief's "VDP needs re-auth", "two SEs compared zero-copy patterns". | L | **Fixed** `6be16e9` (decision 2): a Specialist AE seed overlay (`src/mock/persona-seed.ts`): a forecast call, a pipeline review with the RVP, Org62 discovery, forecast notes, a Deal Role and Sales Events in place of the demo day, SE stand-up, demo-org build and VDP. `smoke:crawl --persona ae` loads it; tests use `personaSeed('ae')`. Test `tests/personas/ae-surfaces.test.ts`. |
| **Today** | The day budget line reads in hours of the persona's day ("~1h 25m your work Monday · ~10h free"), right for both roles. The timeline note read "prep: prep: 20m" for the Initech call (also for the SE). | L | **Fixed** `0a4f199`: the prefix is added only when the label lacks it. Test `src/components/today/__tests__/meeting-prep-note.dom.test.ts`. |
| **Triage** | "6 guesses to confirm: 1 looks done, 3 asks and takeaways, 2 questions": no missed opps (the SE sees "3 possible missed opps"). | – | Correct. (An early walk showed missed opps for the AE: that was the SE seed after a `next dev` restart, see above.) |
| **Outbox** | Messages only; no VDP changes. | – | Correct. |
| **Assistant** | Example prompts are role-neutral ("Why is my #1 first?", "Prioritize customer-facing over internal today", "/rescan slack 2d", "/log last meeting"); the eleven tools are the same for every persona (W12-10); the Persona block names the AE's duties, rules and Sales Events. The Persona block's first line read "Role: Specialist AE (Specialist AE)". | M | **Fixed** `7308af6`: `roleTitle()` names a role once when its level reads the same. Test `tests/personas/personas.test.ts`. |
| **Work** (all seven tabs) | Lists are the seed's items; no persona branch. | – | – |
| **Deals** | Tiles and "Your Specialist Forecasts, at their forecast amount (ACV)"; no DC gaps, no Missed or DCs tab, no "VDP links unverified" banner. `/deals/missed` and `/deals/dcs` show "Not in your role's preconfiguration … Open Role & rules". Account page: no DC need, badge or VDP fact. | – | Correct. |
| **Briefs, Agents, Agents ▸ Tools** | No persona branch. The Talk Track tool says "slides + live demo": a tool's own description. | – | – |
| **Activity** | Lands on Forecast (the AE's default, UX.md); tabs To log · History · Forecast, no VDP; `?view=vdp` shows the not-preconfigured card. Forecast: "FY27 Q4 · 5 Specialist Forecasts · 3 notes due Mon 09:00 (1 overdue) · 2 Deal Roles to set · 1 opp with no record". | – | Correct. |
| Activity ▸ History | The tracking hint read "Missing an opp, a type or hours": an AE's Sales Events take no task type. | M | **Fixed** `0157876`: `tracking(…, { taskType })`, "Missing an opp or hours". Test `src/components/time/ledger.test.ts`. |
| Activity ▸ History | "By task type" lists the SE taxonomy (Demo Prep, Discovery…). | L | Left: it shows only when rows carry a type (`showTypes`); the seed's rows do. A real AE's rows have none, so it hides. |
| Activity ▸ To log ▸ Review | "Not sure? See the likely opps" said "Globex · Negotiation · closes 2026-12-14 · **your DC** · 2.9 meetings": a DC for a role without deal contributions. | M | **Fixed** `08225e7`: `oppOwnerWord(o, dc)`, an opp in the AE's book reads "yours" (the use-case opp picker too). Test `src/components/time/__tests__/review.dom.test.ts` (the persona cases render Review against the mock as each role). |
| Activity ▸ Week / Review | Row issues "Needs an opportunity and a task type." and "Check the type." | L | Left: the seed's issue strings (from the SE logger); no engine path produces them for an AE. |
| **History** | The seed's days (SE meetings). No persona branch. | – | – |
| **Settings ▸ Profile & hours** | The effect pane said "**SE (IC) role pack**" for every user. | M | **Fixed** `7308af6`: the persona's level ("Specialist AE role pack"; the SE's "SE role pack"). Test `src/components/settings/__tests__/settings-page.dom.test.ts` (the persona cases). |
| Settings ▸ Profile & hours | The Role row reads "**Specialist AE (Specialist AE)**". | M | **Fixed** `798c230`: `roleTitle(persona)` ("Specialist AE"; the SE's "SE (Solutions Engineer)"). Test `settings-page.dom.test.ts` (Profile case). |
| Settings ▸ Profile & hours, Settings ▸ Time | "**AEs I cover**" (Profile's slot and Time's list) shows for a Specialist AE, who covers no AEs. | M | **Fixed** `b1c9ed1` (decision 1): hidden for a persona whose Org62 book is not its opp teams; the AE persona declares no covered-AE list. Test `settings-page.dom.test.ts` (Profile and Time cases). |
| **Settings ▸ Role & rules** | Duties, rules with thresholds filled ("$100,000 … older than 7 days … by Monday 09:00"), thresholds, features (Activity logging, Specialist Forecast) and sources (nine, no VDP); Available: VDP, Deal contributions, Missed opportunities, Solutions judgement. The effect read "Specialist AE (Specialist AE) · Preview". | M | **Fixed** `7308af6` ("Specialist AE · Preview"). Test `settings-page.dom.test.ts` (Role & rules case). |
| **Settings ▸ Time** | "Include complete proposed rows" asked for "a task type and an opportunity"; "DC suggestions and Org62 discovery" (products a DC counts for, the default split) showed; discovery said "Your opp teams, the AEs you cover". | M | **Fixed** `7308af6`: no task type for an AE; without deal contributions the block is "Org62 discovery" alone, over "the opportunities you own or are on the team of" (`org62Book`). Test `settings-page.dom.test.ts`. UX.md updated `faa8f97`. |
| **Settings ▸ Connectors** | The table hides VDP, but the "**VDP re-auth**" block (refresh script, Python) showed. | M | **Fixed** `7308af6`: behind `PersonaGate { connector: 'vdp' }`. Test `settings-page.dom.test.ts`. |
| **Settings ▸ Sending** | "**VDP autopilot**", its trusted sites and its daily cap show for an AE without VDP. | M | **Fixed** `cf32e36`: the three rows (and the dry-run dialog's autopilot line) behind `PersonaGate { feature: 'vdp' }`. Test `settings-page.dom.test.ts` (Sending case). |
| Settings ▸ Display, Watches, Scanning, Autonomy, Feedback, Budgets, Data, About, Priority policy, Thresholds, Closing | No persona leak. Priority policy shows "Specialist AE · v4" after a switch. Data's "nothing in Slack, Gmail, Org62 or VDP changes" is a privacy statement and right for every role. | – | – |
| **Health** | Sources shows the AE's set (7 rows in the mock, no VDP). Setup listed "**VDP · Signed out · Re-auth VDP** · Why: Keeps your VDPs current (Solutions Engineers)" and counted it in "1 needs you". | M | **Fixed** `cb7afc1`: `setupDepsFor()` in `src/personas/surfaces.ts` drops a source-only dependency row when none of its sources is active; `healthForPersona` applies it (db and mock), SetupTab applies it to a Check again run. Claude sign-in and the app's rows always show. Test `src/components/health/__tests__/setup-tab.dom.test.ts` (the persona cases). |
| **Getting started** | "2 of 4 done. Four things…", "Claim a deal contribution: Not part of your role." Outcome 4 read "**Log a week** · Your meetings and work become the activity log for Org62" while its step says "On Activity ▸ Forecast, draft the week's notes". | M | **Fixed** `e666605`: `outcomesFor(persona)`, "Update your forecast notes · Fresh notes on your in-quarter Specialist Forecasts, drafted from your week, reviewed and applied in one batch" (page and sidebar popover). Test `src/guide/__tests__/persona-outcomes.dom.test.ts`. UX.md `faa8f97`. |
| **Onboarding** | Role: both roles, "Specialist AE · Preview", "In preview: the forecast workflow is new", preconfigured duties, "Available, not preconfigured: Keep VDPs current (usually the SE's job) · Claim Deal Contributions". Priorities: "Specialist AE starter". Sources: six ready, VDP under Available. Review: "Specialist AE (Preview) · Logs as Sales Events". | – | Correct. |
| Onboarding | Sources' aside and Review say "logging and **VDP changes** wait on Activity"; You says "change any of it later in Settings ▸ **Profile & role**" (the section is "Profile & hours"). | L | Left for the onboarding lane (`steps.tsx`): the exact lines are under "Outside this lane's files". Shot `.shots/persona-qa/ae-onboarding/onboarding-step4-dark.png`. |

## SE, the persona branches the polish and visual QA did not cover

`git log -- src/personas` since the snapshot has two commits (priority@2, the dropped v1 TOOL_GATES table), and
18-ui-polish / 24-visual-qa shot the SE default only, so the SE's side of every persona branch above was re-walked
(`se-after/`).

| Page | What I saw | Sev | Status |
|---|---|---|---|
| Settings ▸ Role & rules | "What follows your role" read "Customer meetings are logged in Org62 as **Solutions Event**, each with an SE task type…" (the SE record type's name is singular). | L | **Fixed** `a4053cf`: "as Solutions Events". Test `settings-page.dom.test.ts`. |
| Settings ▸ Role & rules ▸ Level | "Follows Me ▸ Profile & hours ▸ Role pack", while Profile & hours says "Change them in Role & rules": a loop with no picker at the end. | M | **Fixed** `adbe8d2`: "From your setup. Pick the other level here to change it." Test `settings-page.dom.test.ts`. |
| Settings ▸ Profile & hours | Effect pane "SE role pack" (was "SE (IC) role pack"); the nav still says "SE (IC) · America/Denver". | L | Left: both are right; "(IC)" only in the nav. |
| Settings ▸ Time / Connectors | Task type, DC suggestions with "Your opp teams, the AEs you cover", VDP re-auth: unchanged for the SE. | – | Pinned by the SE cases of `settings-page.dom.test.ts`. |
| Health ▸ Setup | VDP row present for the SE. | – | Pinned by `setup-tab.dom.test.ts`. |
| Getting started | "1 of 5 done", "Log a week". | – | Pinned by `persona-outcomes.dom.test.ts`. |
| Activity | To log · History · VDP; `?view=forecast` falls back to To log (UX.md). Review's rundown keeps "your DC" / "your team". | – | Pinned by `review.dom.test.ts`. |
| Deals, Triage, Onboarding (SE) | DC gaps, Missed and DCs tabs, "3 possible missed opps"; onboarding "SE IC starter", VDP under sources. | – | Correct. |

## Decisions for the owner

1. **"AEs I cover" for a Specialist AE** (Settings ▸ Profile & hours slot, Settings ▸ Time list). It feeds Org62
   discovery, attribution and DC suggestions for the AEs an SE covers. A Specialist AE partners with core AEs, so it
   may mean "core AEs I work with" to them, or nothing. Options: hide it unless deal contributions are active, rename
   it per persona ("Core AEs I work with"), or keep it. Shot `.shots/persona-qa/ae-final/settings-section-time-dark.png`.
   **Decided** (the owner's reading of D-55): an AE row only if the persona's data model has that list. It does not:
   `src/personas/ae.ts` declares `org62Book: 'both'` (opps it owns or is on the team of) and no covered-AE list, so the
   row is hidden for the AE (Profile & hours' slot and Settings ▸ Time's list show only where `org62Book` is
   `'team_member'`, the SE). `b1c9ed1`.
2. **A Specialist AE seed** for the mock. Today the AE persona runs over the SE's world (demos, SE stand-ups, VDP
   morning brief), so QA of the AE's Home, Today and Forecast is QA of the gates, not of an AE's day. A small AE seed
   (`CC_SEED_PATH`) would make the walk honest; it is a data task with placeholders only.
   **Done** `6be16e9`: `src/mock/persona-seed.ts` (`aeSeedOverlay`, `personaSeed('ae')`, `writePersonaSeed('ae', file)`
   for `CC_SEED_PATH`). `npm run smoke:crawl -- --mock --persona ae` starts its server on it (`--seed <file>` overrides);
   `npm run seed:example` is unchanged. Not swapped: the Slack thread snippets, drafts' bodies and the team channel brief
   (they are not Home, Today or Time headlines).

## Outside this lane's files (one-line follow-ups)

| File | Change | Why |
|---|---|---|
| `src/components/settings/BasicSections.tsx:51` | `persona ? roleTitle(persona) : '…'` | "Specialist AE (Specialist AE)" on Profile & hours. **Done** `798c230`. |
| `src/components/settings/BasicSections.tsx` (Sending, the VDP autopilot block, ~l.190–320) | wrap in `<PersonaGate gate={{ feature: 'vdp' }}>` | D-55: VDP is not a daily surface for an AE. **Done** `cf32e36`. |
| `src/components/onboarding/steps.tsx:477, :725`, `:169`, `:715` | **for the onboarding lane**, exactly: `:477` `<p>Command Center only reads your sources. Replies it drafts wait in the Outbox until you approve them; activity logs and record updates wait on Activity until you Apply them.</p>` · `:725` `<p>Every reply is a draft in the Outbox until you approve it, and every log entry or record update waits on Activity until you Apply it. Dry run is on.</p>` · `:169` "…later in Settings ▸ Profile &amp; hours." · `:715` `<b>Settings ▸ Profile &amp; hours</b>: name, hours, time zone.` | "VDP changes" for an AE; the section's old name. Role-neutral words, so the asides need no persona plumbing (the onboarding persona is still a draft there). |
| `src/ops/doctor-service.ts:67` | **for the onboarding lane**, exactly: `  { id: 'vdp-access', label: 'VDP', why: 'Keeps your VDPs current.' },` | "(Solutions Engineers)" is moot now that the row shows only with the VDP source. |
| `src/server/datasource/index.ts` (dev only) | none needed; noted | a `next dev` memory restart reloads the mock seed, so any mock state (the persona) silently resets mid-walk. |

## Verify

- `npm run typecheck`: clean. `npm run lint`: 0 errors, 1 warning (`steps.tsx` max-lines, another lane's).
- `npx vitest run --project ui`: 60 files, 291 tests passed. `npx vitest run --project unit`: 405 files passed
  (2 skipped), 4451 tests, including `tests/personas` (34) and ENG-5's fan-out guard.
- `npm run smoke:crawl -- --mock --port 4414 --persona se`: 43 ok, 0 failed. `--persona ae`: 43 ok, 0 failed.
- The persona tests first lived in three new files; ENG-5's fan-out guard (overlap-flags reached by 58 test files, bound
  55) moved them into the page tests that already reach those pages (`fd1def1`).
