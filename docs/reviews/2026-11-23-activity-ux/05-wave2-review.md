# Activity wave 2: delta review at scale 7 (F1–F7, C10, C11, DC1, DC2, WO-1, docs)

- **Date:** 2026-11-23 · **Lane:** wave2-review (review only; no application code changed) · **Tree:** `e1143c6`
  (diff `9e807a1..e1143c6`; `check:fast` green there: 520 files, 5,145 tests; the touched suites re-run here: 8 files,
  137 tests green)
- **Evidence:** `CC_SEED_SCALE=7 CC_DATA=mock` on :4391; the DOM read with Playwright at 1440 × 900 (both panel states),
  screenshots of `/activity`, `?review=1`, `?view=history` and `/` (in `.shots/`, not committed); `GET /api/v1/today`
  and `/needs` for the counts; `curl -I` on the old links; a work-order render + parse script with hostile cells. GET
  only; the server was stopped afterwards. One Postgres file was not run (the full `test:db` is running elsewhere).
- **Judged against:** the owner's brief (quoted in the task), D-102, D-103, D-47 (amended), D-64, D-65, D-70, D-84,
  ENGINES.md, UX.md Activity, EDGE-CASES rule 9. Not re-reported: DC3/DC4 unbuilt, DC1's default-split text on time
  rows, the rundown's `coverage` contract field, the Postgres suite.

## Verdict: **fix first** (no blocker; three highs, all under 45 min)

The shape holds and the counts now agree end to end: tab **78** = sidebar **78** = Home's queue row **78** = lane 1
**74** + **4** not found; lane 2's header and button name every kind; a time row that gains an opp re-runs the
suggestions through a local recompute, not an Org62 write; the work order is one table per object and verb and the
parser survives pipes and headings inside cells. What stops it shipping: with the panel open the page shows **no rows
at all** (R3-1), the Sending lane with its ▲ 4 failures sits below the fold when the panel is closed (R3-2), and a
Specialist-Forecast-only deal is dropped by the DC product gate on Postgres even though the forecast says Data Cloud
(R3-3), which is exactly the owner's "specialist AE on the opp team" example.

## Findings

**R3-1 · high · One column (panel open): every lane body is hidden; 0 rows above the fold.** At 1440 × 900 after `]`,
`#cc-main[data-panel=open]`, `data-columns="1"`: the three lane sections measure 51 / 83 / 47 px, each shows its header
line (with the ▾ chevron, `aria-expanded=true`) and the pills, and no body (`.shots/activity-x7-1440-open.png`; the DOM
counts 40 / 16 / 4 rows inside the hidden bodies). The user opens the Assistant or a row's details and the work
disappears; AX-1 again in one state. `src/components/kit/LanePage.tsx:167-186`: `shut = !open` and the body class is
`shut ? 'hidden' + TWO_COL.col : 'flex'`; with `openState` empty and `collapsed=false` the lane should read open, so
either `openState` is being set false for every lane on the column switch or the `@container/main` class pair hides the
body in one column. **Fix:** reproduce with `npm run shot -- /activity --port <lane> --scale 7 --open-panel`, make a
lane with work open by default in one column (only `collapsed` lanes start shut, as the kit comment says), and pin it
with a DOM test in `src/components/kit/__tests__/` ("one column: a lane with work shows its rows").

**R3-2 · high · Two columns: Sending (the failures) is below the fold.** Lane 2 opens the Use cases group with its first
8 rows (`ReadyLane.tsx:299-305` `extrasFolded` starts empty; `READY_STEP = 8`), so the right column is 939 px tall and
lane 3's header lands at y = 1155 (closed panel, 1440 × 900). Review 02 had all three headers above the fold; C11 moved
the use cases in and pushed the one place for failures ("▲ 4 not found") off the screen. The brief: failures in one
place, at a glance. **Fix:** in the right column put Sending above Ready when it has a failure, or open the extras
groups as header lines on To log (the rule F3 wrote: "unticked until opened") and keep them open only on Review; either
keeps lane 3 inside 900 px at scale 7. Pin with the existing fold test: lane 3's top ≤ 900 at scale 7.

**R3-3 · high · A deal only a Specialist Forecast names fails the DC product gate on Postgres.** The discovery job
checks eligibility with the forecast's product lines (`org62-discover.ts:294-300` `sfrEligibility(o, productLines…)`,
passes for "Data Cloud"), stores the opp with no products (`attribution.ts:648` `upsertDiscovered` writes name, stage,
amount, no `products`), and the DC rule then gates again with `sellsDcProduct(o, dcProducts)` over `o.products` and the
opp's **name** (`dc.ts:104-110`, called at `:151`); `sfrCandidateFields` (`attribution-sfr.ts:34-37`) hands the candidate
only `specialistForecastOwnerIds` and `seenVia`. So "Globex · Renewal FY27" with a Data Cloud forecast is never
suggested; the mock passes only because its opp carries `products: ["Data 360"]`. **Fix:** `sfrCandidateFields` also
returns `products: [...sfr.productLines]` merged into the candidate's products (or `dcCandidates` merges them), and
`tests/attribution/sfr-context.test.ts` gains the case "an SFR-named opp with no products and a plain name is a
candidate when its forecast type is a DC product".

**R3-4 · medium · Three numbers for one lane: "Fix or approve 74", "ACCEPT 26", "Accept 12 suggestions".** The band
header counts the Internal group's 14 rows (`fix-derive.ts:224` sums every group's rows), the lane count does not (D-64),
and the button takes the 12 with an opp suggestion. The owner reads 26 and gets 12. **Fix:** the Accept band header
reads "Accept 12 · Internal 14" (or counts `counted` rows only), so band + band = lane count (26 − 14 + 62 = 74).

**R3-5 · medium · Lane 2 says 29 use cases, the button logs 8, and nothing says "8 of 29 ticked".** Header "2 rows · 2 h
· 2 DCs · 29 use cases", button "Log 2 rows · 2 DCs · 8 use cases" (`laneCount` counts what can be logged; `laneButton`
what is ticked; the `tickedLine` "12 ticked · 2 h" sits in the lane body, not beside the button, and does not say the
kinds). F3's intent was one story; it is now two true sentences the owner has to reconcile. **Fix:** the header names
the ticked share per kind ("8 of 29 use cases"), or the `tickedLine` moves next to the button and reads "2 rows · 2 DCs ·
8 of 29 use cases ticked".

**R3-6 · medium · The DC row in lane 2 says its coverage twice, and calls an OOO cover "AE you cover".** "Globex ·
Renewal FY27 · 50% DC · AE you cover: Elena Cruz · 50% · covering for Elena Cruz OOO · The missed-opp sweep…" and "…
AE you cover: Morgan Hale · … · Morgan Hale is on this opp and you cover them". `review-derive.ts:313` prepends
`AE you cover: ${s.coveredAe}` to reasons that already carry `coverageReason` (`coverage.ts:83-87`), and for kind `ooo`
the person is a teammate, not an AE I cover. **Fix:** drop the prefix when a `covered_ae` reason is present (it always
is since DC1), and let the reason text carry the kind.

**R3-7 · medium · The context the owner asked for ("which other Data & AI DCs are already on that deal") is not where
Accept happens.** `DcSuggestion.context` is rendered only on Deals ▸ DCs (`DcSuggestions.tsx:97-120`, chips and details);
lane 2's DC rows (`ReadyLane.tsx:516-535`) show `why` and `note` only (0 `[data-context]` elements at scale 7). The
owner accepts from lane 2. **Fix:** `dcExtras` folds `dcContextChips(s.context)` into the row's where cell ("2 other DCs
· via Morgan Hale's forecast"), and the details under the row list them; one test in `review.dom.test.ts`.

**R3-8 · medium · Home's queue row still tells a different story below its first number.** "78 to fix in Activity
(94.25 h) · 74 rows need a fix · 4 not found in Org62 · **1 to approve · 1 ready · 1 batch waiting** for your Apply"
while lane 2 says 2 rows and lane 3 says 2 batches (`src/engines/needs/providers/time.ts`: `ready` = approved only,
`toApprove` ignores Settings ▸ approve complete, and the batch line counts pending canvases only). F1 fixed the headline
(R2-1); the sub-parts are the old formula. **Fix:** derive the sub-parts from `lanesOf`-equivalent inputs
(`readyIds` rule and `sendingOf`'s open batches) or drop them to "74 rows need a fix · 4 not found · 2 ready · 2 batches
in Sending".

**R3-9 · medium · On Postgres the time → DC ripple is asynchronous and nothing wakes the lane.** `useDcRipple`
(`ToLogView.tsx:840-850`) POSTs `refreshDcSuggestions`; the db DataSource **queues** `attribution.dc_suggest`
(`attribution.ts:558-565`, "refreshes the suggestions in a moment"), the client invalidates `time` on the response (before
the worker ran), and the job (`src/jobs/handlers/dc-suggest.ts`) publishes nothing. The mock recomputes synchronously, so
the test and the scale-7 run pass; live, the DC shows on the next unrelated refetch. The read/write question is fine: it
is a local recompute from engagement, never an Org62 write. **Fix:** the job publishes `time` (and `deals`) when its
change set lands, as the scanners do; a db test asserts the publish. Also note the hook fires on every refetch that
brings a new opp (a scanner arrival), not only on a user's answer: gate it on `mine`-style ids from the Accept/pick
paths.

**R3-10 · medium · `legacyShape` drops the legacy rows of a mixed canvas.** A canvas with a legacy `# ADD` table **and**
one per-object table (reachable when `withDcAdds` / `withUseCases` / the forecast writer `upsertTable` into a canvas
staged before WO-1) loses the legacy rows in `legacyShape` (`tables.ts:186-199`: under a non-table heading, lines starting
with `|` are not kept), so `parseWorkOrder` reads only the new table (my script: 1 Event + 1 DC in, 1 DC out).
`canvasRowsOf` reads both (preflight and review are right; the read-back's parser and the DC/use-case hold counts in
`payload.ts` are not). **Fix:** `legacyShape` keeps legacy section rows (`legacySectionOf` → the matching group) instead
of dropping them; a test with a mixed canvas in `tests/time/roundtrip.test.ts`.

**R3-11 · low · `tableOfHeading` is case- and space-sensitive.** `## Events To Create (3 rows)` and `##EVENTS TO CREATE`
read as no table (fine for what the app writes; a hand edit in Slack of the heading's case silently turns the table
into prose for the read-back). **Fix:** compare upper-cased and allow `#{1,3}\s*`.

**R3-12 · low · ENGINES.md and the engine CHANGELOG claim what is not built.** Rule 9's "how to check" says "a constants
snapshot test fails otherwise (D-103 f)": no such test exists, and D-103 (f) is proposed. The CHANGELOG's `dc@2` line
describes (a)–(d) as one change ("one dismissal memory… an account with no open opp is a settled target") while (c) and
(d) are not built, and nothing stamps `dc@2` (`grep rule_version|dc@ src/engines/attribution` is empty). **Fix:** split
the line into built (a)+(b) and proposed (c)+(d); word rule 9's check as "until B-119 lands, the reviewer checks it".

**R3-13 · low · Docs stale after the merges.** `CHUNKS.md` still lists F4, DC1 and DC2 as "running" (all merged);
D-103's status says chunks 1–4 "building" ((a) and (b) are built); EDGE-CASES rule 9 (line 15) still says
`"AEs I cover" planned, D-84` while its own amendment paragraph below it describes the built coverage; D-102 is
"Accepted · building" with C1–C11 and F1–F7 merged. UPGRADING.md matches the code (two updates; `--check` prints the
database line, `migrate-state.mjs:26` / `databasePlan`; the doctor FAILS `DEP.PORT.EXPOSED` on an unbound web plist,
`src/ops/checks/ports.ts:57,77`). CHANGELOG 2.0.0 has no doubled lines (only the section headings repeat across
versions); the C11 and WO-1 lines read plainly.

**R3-14 · low · The Specialist Forecast read includes expired coverage rows.** `org62-discover.ts:234` takes every
enabled covered AE with an Org62 id, window or not; an OOO row whose window ended keeps costing a read (inside the cap).
**Fix:** filter with `coverageActive(a, day)`.

**R3-15 · low · `npm run scan:private -- --no-history` is not clean on this tree**, but none of the four files is in
this wave's diff (`scripts/stress/scenarios/{live,mechanics}.ts` Slack-id-shaped 9, `config/team.json` 1,
`docs/archive/ARCHITECTURE-2026-10-proposed.md` Org62-id-shaped 1, all present at `9e807a1`). The seed's new rows are
placeholders (`Morgan Hale`, `005XX0000SEEDMHAAA`, `example.com`; `MOCK_SPECIALIST_FORECASTS` uses `…0001AAA` ids).
Not this wave's; it blocks a push until moved or placeholdered.

## Count check (scale 7, the same moment)

| Surface | Says | Agrees? |
|---|---|---|
| Header sentence | "Q4 FY27 · 21.5 of 60 h in Org62 · 6.7 h ahead of pace · due tomorrow 12:00 ▸ History" | n/a (by design, no needs-you number) |
| Tab badge | To log **78** | yes (74 + 4) |
| Sidebar | Activity **78** ("waiting for approval") | yes (`navCounts.toLog` 78; C10 closed) |
| Home queue row | "**78** to fix in Activity (94.25 h) · 74 need a fix · 4 not found · 1 to approve · 1 ready · 1 batch waiting" | headline yes; sub-parts no (R3-8) |
| Lane 1 header | Fix or approve **74** · Accept **12** suggestions | yes (Internal 14 outside, D-64) |
| Lane 1 bands | ACCEPT **26** · REVIEW **62** | 26 includes Internal 14 (R3-4); 12 + 62 = 74 |
| Lane 2 header | **2 rows · 2 h · 2 DCs · 29 use cases** | yes (what can be logged) |
| Lane 2 button | **Log 2 rows · 2 DCs · 8 use cases** | truthful; header and button differ on use cases (R3-5) |
| Lane 2 ticked line | 12 ticked · 2 h | yes (2 + 2 + 8) |
| Lane 3 header | **2 batches · 14.5 h · ▲ 4 not found** | yes |
| Review page | header "2 rows · 2 h · 2 DCs · 29 use cases" · button "Log 2 rows · 2 DCs · 29 use cases" · 33 ticked · "31 more rows need an opp first ▸ Fix or approve" | yes (F5; extras open and ticked on Review) |
| History card | "45 h need you · 38 rows · 2 h ready · 2 rows · 2 batches in flight ▸ Sending" | 38 is the current quarter's share of 74 (the lanes reach back to Q3; the card is Q4's by design, F1 note); batches yes (F4) |
| Select all | lane 1 has none (group boxes, band headers, ticked bar); lane 2's group boxes | n/a |

Old links (`curl -I`, all 200, client-side rewrite): `/time?view=needs|week|usecases|ledger|log|forecast|bogus`,
`?view=vdp&sub=mine`, `?view=weeks&week=…`, `/activity?review=1`, `?view=history`, `/history`.

## Above the fold at 1440 × 900

| Panel | What is inside 900 px | Verdict |
|---|---|---|
| **Closed** (two columns) | Sentence, tabs; lane 1 header "74 · Accept 12 suggestions", grouping toggle, ACCEPT 26 band, 4 open groups (Q3 Initech 3, Q3 Cyberdyne 1, Internal 14 with 8 shown, Hooli 1) with 37 rows visible; lane 2 header with count and the filled Log button, Day/Account, "12 ticked", both time rows, DCs to claim (2, both with Accept), Use cases 29 (8 shown, 5 visible). **Not** visible: the REVIEW 62 band (y ≈ 1,000 in the left column), **Sending** (y = 1,155). | J1 and J2 yes; J3 (failures) **no** (R3-2); the Review band is a scroll away, which is acceptable since it is "the rest". |
| **Open** (one column) | Sentence, tabs, three pills with counts, three lane header lines with counts and buttons ("Accept 12 suggestions", "Log 2 rows · 2 DCs · 8 use cases", "▲ 4 not found"), the use-case reference fold. **No rows.** | **No** (R3-1). |

Nothing Org62-bound is in a fold: DCs, use cases and Event changes are groups of lane 2 (the only fold left, "Use cases to
settle in Org62, and every use case", is reference, not a batch item). Review rows are grayed (`text-muted`, measured
rgb(188,197,209) vs rgb(229,234,242) in the Accept band), each reads "72% · review" with its own Accept, their groups
start folded, and none is in "Accept 12 suggestions" (`fixLane().suggested` filters by the Accept band).

**The ripple** (read in the code and the DOM): Accept or a pick PATCHes the row; `useDcRipple` sees a new opp id among
the rows, POSTs `refreshDcSuggestions` (`assistant: 'deny'`, local data only: engagement, teams, coverage); the mock
re-plans at once and `getDcSuggestions` refetches on topic `time`; `dcExtras` adds the DC with "from your time on
<day>" (`dcTimeNote`). No Org62 call anywhere on the path. On Postgres it is queued (R3-9).

## DC1 / DC2 read in the code

- `coverageOf` (`coverage.ts:57-68`): owner → team → SFR owner, kind `ae` over `ooo` over `sme`, window checked on
  `asOf` (the DC batch passes today, the scorer the evidence's day, the rundown today); no `asOf` means no window check
  (callers all pass one). Shares default 100/50/25; a row's `creditShare` wins.
- `ae` alone suggests, unticked: `dc.ts:149` pushes `covered_ae` for kind `ae` without `touched`; `preTicked` needs
  `strong` (team/work), which coverage never sets. `ooo`/`sme` need `touched`; their share caps the split (`:184`).
  EDGE-CASES AT-09/AT-10 and the rule 9 amendment match this; rule 9's headline line does not (R3-13).
- Accepted DCs survive a coverage edit (`dc.ts:164` skips `accepted`/`edited`); old settings load (every new field
  optional; `coverageRefsOf` tolerates absent kind/window/share).
- The Specialist Forecast SELECT (`discover.ts:354-359`): bound ids only (validated, quoted), `SpecialistForecast__c`
  with `ForecastType__c IN` the four Data & AI types, open opps, `LIMIT 200`, through `runOneReadLookup` on `soqlQuery`
  (the allowlist; a `disallowed_tool` answer is a `bug` JobError), the same `read` closure and daily cap as the team
  read; `seenVia: 'sfr'` on the ext (`attribution-sfr.ts:22`); skips recorded as `{opp, reason}` codes only.
- Context is per opp (`loadDcContexts` keys by opp id; `dcs` filtered `!isMine`; specialists from team roles matching
  /specialist/ plus forecast owners); the UI says "Specialist Forecast", never the acronym (`document.body.innerText`
  has no `SFR`; `DcSuggestions.tsx:168`).
- Parity test green with the coverage rows present (`tests/ui/counts-parity.test.ts`, `tests/attribution/mock.test.ts`).
- Nothing writes to Org62: the only new writes are the mirror's ext (`mergeExt`) and kv state.

## WO-1 read in the code and tried

- Writer: `TABLES` (`tables.ts:38-54`) one spec per object × verb with its own columns; `upsertTable` inserts in the
  fixed order and recounts the heading; `rerenderCanvas` rebuilds each heading from its kept rows and removes an empty
  table. The size note in `payload.ts` is right (9/6/12/6/4 columns; 33 Event rows under 300 cells).
- Parser: kinds come from headings (`canvasRowsOf` → `tableOfHeading`), rows are normalised to the legacy cell layout,
  so D-65's CC# key matching (`ccKeyOf(cells[9])`) and D-70's landings are unchanged; a legacy `# ADD`/`# UPDATE`
  canvas still parses (`legacySectionOf`), and `tests/time/roundtrip.test.ts` + `tests/outbox/canvas.test.ts` cover both.
- Hostile cells: a Subject "Weekly | sync ## EVENTS TO CREATE" and a Description "a | b⏎## UPDATE⏎# ADD trick · CC#r1"
  come back as one row with `ref: r1` (pipes become `/`, newlines `⏎`, so no line can start with `#` or `|`); the
  update's Why with `|` and `##` survives. A DC row lands in DEAL CONTRIBUTIONS TO CREATE and parses as `dc` with its
  Opportunity__c id. The mixed canvas fails (R3-10).
- Slackbot words: one paragraph per table under its heading, each naming the columns as fields; the callout says "one
  table per job… top to bottom". The Events paragraph is six sentences (duplicates, Sales Events, REPLACES, internal
  rows): not short, but each sentence is a rule Slackbot has needed before; unambiguous.

## Brief vs built

| Owner's words | Status | One line |
|---|---|---|
| "Everything that needs to go to Org62 should be in one place" | met | Lane 2 holds time rows, DCs, use cases, Event changes; one Log, one batch (D-47) |
| "you don't know what you're actually accepting when you accept all" | met (lane 1) · partial (lane 2) | "Accept 12 suggestions" takes the Accept band only; lane 2's button names what it stages, but the header's 29 vs the button's 8 (R3-5) and no context on DC rows (R3-7) |
| "not a good suggestion or not confident → grayed out, required that I review" | met | Review band: grayed, folded, never in Accept N, each row its own Accept |
| "answers to time logging could add or change DCs below" | met on mock · partial on Postgres | ripple is a local recompute; live it is queued with no wake-up (R3-9) |
| "Scanners should know the AEs I directly support and scan for the deals they're part of (specialist forecast)" | partial | discovery reads their Data & AI Specialist Forecasts; the DC rule then drops a forecast-only deal whose name lacks a product word (R3-3) |
| "OOO coverage and SME assists … still picked up, maybe partial credit" | met | kinds `ooo`/`sme` with windows and 50/25 default splits; need my work on it (by design) |
| "dismiss and don't bring it back unless I'm on a call" | not | DC3, planned |
| "context on which other Data & AI DCs are already on that deal" | partial | on Deals ▸ DCs, not in lane 2 (R3-7) |
| "attribute to Opportunity or Account" | not | DC4, planned |
| "not one feature per case: fix how it reasons" | met | one matcher, coverage as data, ENGINES.md rules |
| "a log of why engine rules changed" | partial | `docs/engines/CHANGELOG.md` exists; no version is stamped and the `dc@2` line overstates (R3-12) |
| "balance tokenomics" | met | the forecast read is one SELECT per ≤ 200 ids under the same cap; no model call added |
| "one table per combination of Use Case, DC, or Event and create/update; Slackbot is dumb" | met | seven tables, own columns, own paragraph, fixed order; legacy canvases still read |

## The owner's four examples against the engine

| Example | Today | Gap |
|---|---|---|
| A specialist AE on the opp team (not the owner) | `coverageOf` matches `via: 'team'` from `opportunity_team_members`; kind `ae` suggests unticked | a discovered opp with no products and a plain name is dropped by the product gate (R3-3) |
| An OOO cover | kind `ooo`, window, 50 %: suggested once I have work on it, split capped at 50 | the window is not applied to the forecast read (R3-14); the DC row's words call them an AE I cover (R3-6) |
| A manager-requested DC with no activity | nothing: no evidence, no coverage match → never suggested | out of scope of D-103 (a)/(b); a "requested by" marker (B-114's cousin) is the only path |
| Two specialists on one account | context lists the other DCs and specialists per opp; `otherArchitectDc` makes the split a question | the owner sees it on Deals ▸ DCs, not on the row they Accept (R3-7) |

## What is good

The one row set is real: five surfaces say 78 for the same reason, and the Q3 rows that review 02 found on no page sit
first in lane 1 under their quarter. The Accept/Review bands are the brief's grayed-out rule made visible, and the band
rule (`bandOf`) is one function. Lane 2's button is honest. `coverageOf` is the kind of general rule ENGINES.md asks
for, and its three callers share it. The Specialist Forecast read is a fixed SELECT with ids only, behind the cap and
the allowlist, and the eligibility skip says why. The canvas tables are a clean cut: the writers emit the new layout,
every reader sees the old one, and the hostile-cell test passed first time. ENGINES.md is readable and its "how to
check" column is mostly greppable.

## Fix chunks (≤ 45 min each, severity order)

| # | Chunk | files: | Done when |
|---|---|---|---|
| 1 | **R3-1 one-column bodies** | `src/components/kit/LanePage.tsx`, `src/components/kit/__tests__/**`, `app/dev/kit/lanes/**` | `shot --open-panel` at scale 7 shows lane 1's rows; a DOM test pins "one column: a lane with work is open" |
| 2 | **R3-2 Sending above the fold** | `src/components/time/ToLogView.tsx`, `src/components/time/ReadyLane.tsx`, `src/components/time/ready-derive.ts`, `src/components/time/__tests__/**` | lane 3's header ≤ 900 px at scale 7 two-column; extras folded on To log, open on Review |
| 3 | **R3-3 forecast product lines reach the DC gate** | `src/server/datasource/db/attribution-sfr.ts`, `src/server/datasource/db/attribution.ts`, `src/server/datasource/mock/attribution.ts`, `tests/attribution/sfr-context.test.ts`, `tests/db/attribution/**` | a forecast-only opp with no products and a plain name is a candidate; db test green |
| 4 | **R3-4 + R3-5 band and lane 2 numbers** | `src/components/time/fix-derive.ts`, `src/components/time/FixLane.tsx`, `src/components/time/ready-derive.ts`, `src/components/time/ReadyLane.tsx`, `src/components/time/__tests__/**`, `tests/time/review.test.ts` | "Accept 12 · Internal 14"; "8 of 29 use cases" beside the button |
| 5 | **R3-6 + R3-7 DC rows in lane 2** | `src/components/time/review-derive.ts`, `src/components/time/ReadyLane.tsx`, `src/components/time/DcSuggestions.tsx` (export the chip helpers), `src/components/time/__tests__/review.dom.test.ts` | no doubled coverage words; the row shows "N other DCs · via <AE>'s forecast" |
| 6 | **R3-8 queue row sub-parts** | `src/engines/needs/providers/time.ts`, `tests/needs/**`, `tests/time/internal-activity.test.ts` | the row's parts equal lane 2 and lane 3 at scale 7 |
| 7 | **R3-9 the ripple wakes the lane on Postgres** | `src/jobs/handlers/dc-suggest.ts`, `src/components/time/ToLogView.tsx`, `tests/db/attribution/**` | the job publishes `time`/`deals`; the hook fires only for the user's own answers |
| 8 | **R3-10 + R3-11 mixed canvas and heading tolerance** | `src/lib/canvas/tables.ts`, `tests/time/roundtrip.test.ts`, `tests/outbox/canvas.test.ts` | a legacy ADD row survives `legacyShape` beside a new table; case/space-tolerant headings |
| 9 | **R3-12 + R3-13 + R3-14 docs and the window filter** | `docs/ENGINES.md`, `docs/engines/CHANGELOG.md`, `docs/EDGE-CASES.md`, `docs/decisions/0102-*.md`, `docs/decisions/0103-*.md`, `docs/reviews/2026-11-23-activity-ux/CHUNKS.md`, `src/jobs/handlers/org62-discover.ts`, `tests/db/attribution/**` | status lines match the tree; `dc@2` split into built and proposed; expired rows skip the forecast read |
