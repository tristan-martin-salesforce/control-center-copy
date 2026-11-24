# Activity lanes: delta review at scale 7 (C1–C9)

- **Date:** 2026-11-23 · **Lane:** lanes-review (review only; no application code changed) · **Tree:** `e2a0629`
  (diff `7ef192b..e2a0629`, `check:fast` green: 519 files, 5,098 tests)
- **Evidence:** `CC_SEED_SCALE=7 CC_DATA=mock` on :4380 (126 activity rows, 5 batches); screenshots of `/activity`,
  `?review=1`, `?view=history`, `?show=week`, `/history` and `/` at 1440 × 900 and 1920 × 1080 (in `.shots/`, not
  committed); the API read for the counts (`GET /api/v1/needs`, `/api/v1/time`, `/api/v1/time/log`). GET only; the
  server was stopped afterwards. The AE overlay was **not** shot: `shot.mjs` has no `--persona`, and the crawl's
  persona switch POSTs settings, which a reviewer may not do (manual check below).
- **Judged against:** the owner's brief (the three jobs, exact actions, one place for failures, no duplication, use
  the width, not overwhelming at scale), D-102, D-47, D-64, D-65, D-70, D-86, D-87. Not re-reported (C10): sidebar
  badge on the old count, Sending's second filled button, settled batches still in Sending, `?batch=` dropped by old
  links, no one-column screenshot.

## Verdict: **fix first** (one blocker, four highs; all small)

The shape is right: at scale 7 the fold at 1440 × 900 holds all three lane headers with their counts and buttons, five
fix rows in four open groups, both ready rows, both in-flight batches and the first not-found row. That is AX-1 fixed.
What stops it shipping is that the page and the queue still count different sets (R2-1: the queue says **78**, the
tab says **38**, and 39 of the difference are rows the page never shows), and two of the three lanes contradict their
own numbers or hide the thing the job needs (R2-2 titles, R2-3 the Log button).

## Findings

**R2-1 · blocker · Home's queue row and To log count different rows; 39 live rows are on no page.** At scale 7 the
queue row reads "78 to fix in Activity (94.25 h) · 74 rows need a fix · 4 not found in Org62 · 1 to approve · 1 ready
· 1 batch waiting for your Apply" (Home, and the Week view's "Needs you here" on the same tab), while the List reads
"To log 38", "Fix or approve 35", "Ready to log 2 rows", "Sending 2 batches · ▲ 3 not found". The 74 vs 35: the
provider counts every live row the DataSource holds (`src/engines/needs/providers/time.ts:42-60`, its own `needsFix`),
the page counts `lanesOf` over `q4Range` (`src/components/time/quarter-hooks.ts:24`, `derive.ts:455`: the quarter so
far, at least 3 weeks), and the scale seed puts 39 fix rows in October (Q3 FY27). Those 39 rows are exactly the brief's
case (a seller behind on logging has last quarter's rows) and they appear on **no** page: not lane 1, not Review, not
History's current quarter. `fix-derive.ts` already orders groups by "quarter due soonest" (`compareGroups`,
`quarterEndOf`), so lane 1 was designed to hold them. Also from the same cause: "1 to approve · 1 ready" vs lane 2's
"2 rows" (the provider ignores Settings ▸ approve complete), "4 not found" vs "3", "1 batch waiting" with no word of
the second batch. C1's acceptance ("the queue's time row reads it too") is not met: `timeNeedCount` copies the formula,
not the inputs. **Fix:** compute the lanes once from one row set: either widen `useQuarterPath`'s range to every live
row (q4Range from the oldest live row's quarter start, so Q3 rows join lane 1 under their own due date) and have the
provider call `logPath` + `lanesOf` over the same range and `approveComplete`, or move `lanesOf` server-side into
`GET /time` and have both read it. Add a test that asserts the queue row's number equals `lanesOf(...).badge` on the
scale seed.

**R2-2 · high · Lane 1 rows truncate their title to seven characters at 1440.** "demo-ki…", "Hooli on…", "Umbrell…",
"Data 36…", "SE team…" (two columns, main ≈ 1,200 px, each column ≈ 580 px). J1 is "see what it was and what it was
attributed to"; with the title gone the row is unjudgeable and the user opens every chevron. Cause:
`src/components/kit/ActionRowCompact.tsx:115` gives the title `flex-1 min-w-[5rem]` and `:176` gives the where cell
`flex-[1.5] max-w-[20rem]`, so the where cell wins the free space even when, inside a "Suggested: <opp>" group, it
holds only "72% likely". The 100 px lead (`:148`, weekday + date + time) takes another sixth of the row. **Fix:** title
`flex-[2]`, where `flex-1` with `flex-initial` when `groupTarget` empties it (it then needs ~5rem: "72% ✓"); lead
`w-[4.5rem]` showing "Mon 9 17:00" without the weekday under a container query of the lane column (`@container`), or
drop the time when the group is by day. Verify with a 1440 two-column screenshot: every title ≥ 20 characters.

**R2-3 · high · Lane 2's one button says "Log 31 · 2 h" under a header that says "2 rows · 2 h".** 29 use cases are
ticked by default (`use-ready-log.ts:38`, extras pre-ticked) and counted in the button (`ready-derive.ts:76`
`laneButton`) but not in the header (`:71` `laneCount`, time rows only), while VDP is signed out in the same sidebar
("VDP needs re-auth"). The one filled button on the page names a number the lane does not explain, and a press stages
29 Org62 use-case writes the user did not look at (they are folded: "Use cases (29) 29 · Show 29"). D-47 holds (it is
one batch for Apply), but the brief's "the actions I need to take … should be clear" does not. **Fix:** the header
count names what the button will log ("2 rows · 2 h · 29 use cases"), the button reads "Log 2 rows · 29 use cases" (or
"Log 31: 2 rows, 29 use cases"); on To log leave the folded extras **unticked** until the fold is opened (Review keeps
them ticked and open, as C7 chose). Also the group label repeats its count ("Use cases (29) **29**"): drop the
parenthesis in `extraGroups`.

**R2-4 · high · A batch's life is still told in three places, with three names and two numbers.** To log ▸ Sending
says "Batch 22 Nov · 8 rows · 8.5 h · Staged · Applied(current) · Sent · Checked · Review & apply"; History's quarter
card (`QuarterHeader.tsx`, now on History per C8) says "6 h to apply · 6 rows", "11 h to send to Org62 via Slackbot ·
9 rows" and five lines "Activity log · batch 1 (Sun 22 Nov, 8.5 h): 2.5 h will land in Q3 FY27, 6 h in Q4 FY27 …
batch 5"; and lane 2's footer (`Q4Log.tsx:341`) says "Last batch: Sun 22 Nov 09:02 · Open". Same batch: "Batch 22 Nov"
in one place, "batch 1" in another, 8 rows here and 6 rows there. D-102 says in-flight progress is shown once, in
Sending; History owns the finished. **Fix:** the card's "Waiting on you" block drops "to apply" and "to send" and its
per-batch lines for batches still in Sending (keep the cross-quarter "landed in" lines only for finished batches, or
move them to History ▸ Batches' lines); delete lane 2's "Last batch" footer (Sending's newest line is that). Name
batches the same everywhere (R2-5).

**R2-5 · medium · Two batches on the same day are both "Batch 22 Nov".** `sending-derive.ts:154` labels by day only
(`whenOf` = appliedAt ?? createdAt); at scale the pending batch (created 22 Nov) and the applied one (applied 22 Nov)
read the same, and J3 is "track one or more logs". History's card calls them "batch 1 … batch 5". **Fix:** "Batch 22
Nov 09:02" always (the time is cheap and stable), and when a batch has a title from the canvas, that; use the one
`batchLabel` in `sending-derive`, `history-derive` and the tracking card.

**R2-6 · medium · Review (`?review=1`) is not lane 2 at full width; it is lanes 1 and 2 merged, with its own count.**
At 1920 the Review header reads "READY TO LOG · 36 rows · 43 h · 36 rows · 29 use cases · 27 need you · 38 ticked · 8
h" (`ReadyLane.tsx` `full`, fed `needOpp` from `ToLogView.tsx:88`): 27 of its 36 rows are lane 1's "pick an opp" rows,
unticked and untickable, under a heading that says Ready. The same tab's lane 2 says "2 rows". D-102: Review stays
"as lane 2 at full width". **Fix:** on Review pass `needOpp` only as the rows with a settled suggestion (the "unsure"
kind that a pick ticks), or drop `needOpp` and link "27 need you first ▸ Fix or approve"; the header count must be
`laneCount` of the same rows lane 2 shows.

**R2-7 · medium · "Also waiting" sits under the longest column, two screens down.** `ToLogView.tsx:212` renders the
line after `LanePage`; at scale lane 1 is ~11 groups tall, so the DCs (2 claims the Week view shows at the very top
as queue rows) and the use cases that need you are the last thing on the page, below Internal. The brief: "what's open
for them" at a glance. **Fix:** render the "Also waiting" line between the tabs and the lanes (one line, no height
cost), or as lane 3's footer in the right column; keep the folds where they are.

**R2-8 · medium · j / k do not move in lane 1.** `FixLane.tsx:167` is a bare `<div role="grid">`; `RowGrid`
(`ActionRowCompact.tsx` `moveRowFocus`) is what gives j/k to a grid and lane 1 does not use it (lane 3 does, lane 2
has its own keys). Space, x, Enter work (ActionRow). **Fix:** replace the div with `RowGrid label="Fix or approve"`;
a test in `activity-needs.dom.test.ts` that j moves focus across a group header.

**R2-9 · medium · Lane 2 carries lane 1's verb: "Approve 1 now".** `Q4Log.tsx:296-316` keeps the old secondary step
("Approve 1 now" approves a held row that lane 1 lists under "Check and approve"); AX-4 named this mix and the lanes
were meant to end it. With it, the "Last batch" footer (R2-4) and the dry-run line, lane 2 has a footer of three
unrelated lines. **Fix:** delete the `approveNow`/`secondary` block; the DC-only "Log DCs now" (`dcsStep`) moves to
the DCs fold where its subject is.

**R2-10 · medium · The not-found row's reason is unreadable in the right column.** "▲ Not fo…" at 1440 (the where
cell of the compact row under a batch, `SendingLane.tsx` `NotFoundRow` → `ActionRowCompact.tsx:176` max 20rem but
truncated by the row's other cells). The one failure state the page has must read in full. **Fix:** with R2-2's cell
sizing; and for a failure row drop the lead's time ("Thu 5") so the reason has the room; the batch line already says
"▲ 1 not found", so the row can say the short reason ("Not in Org62" / "Deleted in Org62") with the long one as the
title attribute and in the details panel.

**R2-11 · low · The pending batch's filled step reads "Applied".** `sendSteps` marks the current step `current`
(filled, accent) and for a pending batch that is "Applied", which reads as done. **Fix:** label the current step as
the action ("Apply ▸"), or fill with an outline, not the accent, until done.

**R2-12 · low · Every Ready group has a "Hide" button; group labels repeat the account.** `ReadyLane.tsx:281` puts
Hide / Show N on each day group (a 1-row day has a Hide button); lane 1's chevron-on-the-label is the better pattern.
Group labels "Soylent Foods · Soylent · Data 360 Pilot", "Umbrella Health · Umbrella · Patient 360"
(`compact-derive.ts` `accountOpp` dedups only a prefix match). **Fix:** group toggle on the label (as `CompactGroupHeader`
with `onToggle`); `accountOpp` drops the account when the opp name's first word is the account's first word.

**R2-13 · low · A row that changes group mid-edit goes behind the pill.** `useLiveFix` keys rows `kind|id`; setting an
opp on a row that still lacks a type moves it from `opp` to `type`, which the live list sees as leave + arrive, and
with the hold on (the user is typing) the arrival waits behind "1 more row". The row the user just fixed vanishes.
**Fix:** key by `id` only and let the group change be an in-place update.

**R2-14 · low · Dead code and a dead branch.** `Q4Log.tsx` `logBatch` without `dcOnly` (the "New logging run" toast
path) is unreachable (only `dcsStep` calls it); `canvasCounts` and `q4CurrentStep` are exported and used by nothing
outside the file; `LogItProps.dcs` is "unused since C5". `Q4Log` still derives a batch's next action from
`rows-derive splitRuns` for ⌘↵ and its sr-only "Next:" line, a second rule beside `sending-derive sendNext`.
**Fix:** delete the branch and the exports; ⌘↵ runs the Sending lane's first `next`.

## The three jobs at scale 7

| Job | Where | Clicks | Above the fold at 1440 × 900? |
|---|---|---|---|
| J1 fix or approve time + attribution, look it up in Org62 | Lane 1, grouped by suggestion; group "Accept N"; row chevron → details (Org62 search there) | 1 per group (Accept N); 2 per odd row (where → pick) | **Yes**: header, "Accept 23 suggestions", 4 open groups, 5 rows, 6 group headers. But the titles are unreadable (R2-2), and 39 of the rows are not on the page (R2-1) |
| J2 what is approved and waiting | Lane 2, by day, ticked, "Log N · h" | 1 (Log) | **Yes**: header, 2 rows, the use-case line. The button's number does not match the lane (R2-3) |
| J3 track one or more logs; see history | Lane 3: one line per batch, four steps, its next action, not-found rows under it; History ▸ Batches for finished | 1 per batch (its next action); Log again / Leave out on a row | **Yes**: both batches and the first not-found row. But two batches share a name (R2-5), the reason truncates (R2-10), and History's card re-tells the in-flight part (R2-4) |

Under five seconds: J2 yes; J1 and J3 only for what is on the page, and the owner cannot know what is not (R2-1).

## Count check (scale 7, the same moment)

| Surface | Says | Agrees with `lanesOf`? |
|---|---|---|
| Header sentence | "Q4 FY27 · 21.5 of 60 h in Org62 · 6.7 h ahead of pace · due tomorrow 12:00" (no needs-you number by design) | n/a |
| Tab badge | To log **38** | yes (35 + 3) |
| Lane 1 header | Fix or approve **35** · Accept **23** suggestions (group verbs sum 2+1+1+1+4+5+6+3 = 23; Internal 8 outside) | yes; D-64 holds |
| Lane 2 header | **2 rows · 2 h** | yes |
| Lane 2 button / ticked line | **Log 31 · 2 h** · 31 ticked | **no** (R2-3: extras) |
| Lane 3 header | **2 batches · 14.5 h · ▲ 3 not found** (batch lines show ▲ 1 + "Earlier batches") | yes |
| Review header | **36 rows · 43 h** · 27 need you · 38 ticked | **no** (R2-6) |
| History card (Q4) | 45 h need you · **38 rows** · 2 h ready · 2 rows · **6 h to apply · 6 rows** · 11 h to send · 9 rows | 38 yes; the batch part contradicts Sending (R2-4) |
| Home / Week queue row | **78 to fix** · 74 need a fix · 4 not found · 1 to approve · 1 ready · 1 batch waiting | **no** (R2-1) |
| Sidebar | Activity **1** | no (C10, known) |
| Select all | lane 1 has no Select all; group boxes and the ticked bar instead | n/a |

Failure states: not-found rows appear in Sending only (and as a count on its header and the tab) — one place, as
asked. Batch-level failure: Sending only. History's card still says "to send via Slackbot" (R2-4).

Old links (`curl -I`): `/time?view=needs`, `?view=needs|week|weeks|usecases|ledger|log|forecast|bogus`,
`?view=vdp&sub=mine`, `?review=1`, `/history` all answer 200 (the rewrite is client-side; `tests/time/views.test.ts`
covers the targets).

## Invariants read in the code (good)

- Nothing leaves without approval: lane 2's `logThese` re-reads, PATCHes the suggestions it takes (the Accept path,
  `acceptPatch`) and POSTs **one** `stageLogBatch` with the ticked ids; nothing else in the lanes writes
  (`use-ready-log.ts`). Accept / Set opp / Internal / Leave out go through `usePatchRows` + `fixPatch` as before.
- D-65 intact: Log again / Leave out are `useRelog` on the row under its batch and in "Earlier batches"; Re-check Org62
  is `checkCanvasOrg62` (read). D-70: the batch chevron opens the draft panel whose `CanvasRunStatus` lists the writes.
- D-64: internal rows are a group, `counted: false`, never in `fix`, `badge` or "Accept N suggestions".
- One rule inside the page: `fixLane().count` = `fixRowsOf` = `lanesOf().fix`; `sendingOf` reuses `batchDone` /
  `batchFailed`; History's `finishedBatchesOf` without `unsettled` is the complement of Sending's list.
- Plain words: no "canvas", "read-back" or decision ids in lane copy (only `data-*` attributes and toasts that predate
  the chunks); `tests/ui/time-plain-words.test.ts` extended.
- Keyboard and AT: lanes are `<section aria-labelledby>`, pills are `<button aria-controls>`, the collapse chevron has
  `aria-expanded`, rows are named by title, the where cell by what it says, failure rows "Failed: …", checkboxes
  labelled "Tick …" / "Log …"; Space and x tick, Enter opens (R2-8 for j/k).
- One-column switch is pure CSS on `#cc-main[data-panel=closed]` + `@min-[1100px]/main` (`AppFrame.tsx:89` has
  `@container/main`), mirrored in JS only for the pills; no flash.
- `localStorage` / `sessionStorage` reads and writes are all inside try/catch (`FixLane.tsx`, `ready-derive.ts`,
  `Q4Log.tsx`).
- Live: lane 1 keeps the arrival hold (`useArrivalHold`, `burst: Infinity`); lane 2 keeps ticks across refetches by
  snapshot.
- Lengths: largest touched files 353 / 352 / 362 lines, under the 600 warn; LanePage is Tailwind + tokens, no page
  CSS. ENG-5 ratchet untouched and green. `NeedsYou.tsx`, `InternalRows.tsx`, `ReadyToLog.tsx`, `LogReview.tsx`
  deleted; `CanvasRuns.tsx` reduced to the panel status.

## What is good

Above the fold is now the work. Grouping by suggestion with one Accept per group is the right J1 shape, and "Accept
23 suggestions" equals the sum of the groups. The scale seed (`CC_SEED_SCALE`) and the `--scale` shot naming make the
judgement repeatable. `LanePage` is a real kit frame the other dense pages can take. Sending reads as one line per
batch with a visible next action, and failures land there and nowhere else on To log. History's row list says "in
batch 22 Nov" quietly. Journal is one word that ends the two-Histories confusion.

## Fix chunks (≤ 45 min each, severity order)

| # | Chunk | files: | Acceptance |
|---|---|---|---|
| F1 | **One row set, one rule (R2-1).** `useQuarterPath` range = from the oldest live row's quarter start (fall back to q4Range); the queue's time row built from `logPath` + `lanesOf` over the same range with `approveComplete` (or `lanes` added to `GET /time` and both read it; the contract edit is the orchestrator's) | `src/components/time/{quarter-hooks.ts,derive.ts,lanes-derive.ts}`, `src/engines/needs/providers/time.ts`, `src/server/datasource/{db,mock}/needs.ts`, `tests/needs/providers.test.ts`, `tests/time/time-derive.test.ts` | On the scale seed the queue row's number = tab badge = 38 + the Q3 rows, and lane 1 shows a "Q3 FY27 · due …" group first |
| F2 | **Compact row widths (R2-2, R2-10).** Title `flex-[2]`, where `flex-1`/`flex-initial` when the group names the target, shorter lead under the lane's container query; failure rows show the short reason | `src/components/kit/ActionRowCompact.tsx`, `src/components/time/{CompactActivityRow.tsx,compact-derive.ts,sending-derive.ts}`, `src/components/kit/__tests__/ActionRow.dom.test.ts` | 1440 two-column shot: every lane-1 title ≥ 20 chars, every not-found reason whole |
| F3 | **Lane 2 says what it logs (R2-3, R2-9, R2-4's footer).** Header count includes extras; button "Log 2 rows · 29 use cases"; folded extras unticked on To log; delete Approve-now and Last-batch footers; "Use cases (29) 29" → "Use cases 29" | `src/components/time/{ready-derive.ts,use-ready-log.ts,ReadyLane.tsx,Q4Log.tsx}`, `src/components/time/__tests__/review.dom.test.ts`, `tests/time/review.test.ts` | Button count = header count on To log; Review unchanged |
| F4 | **History owns the past only (R2-4, R2-5).** One `batchLabel` with the time; the card drops "to apply / to send" and in-flight batch lines; finished batches' "landed in" lines move to History ▸ Batches | `src/components/time/{sending-derive.ts,history-derive.ts,QuarterHeader.tsx,derive.ts,HistoryParts.tsx}`, `tests/time/{roundtrip,history,applied-canvases}.test.ts` | Each in-flight batch is named once, on Sending; History's card has no Slackbot line while a batch is in flight |
| F5 | **Review = lane 2 (R2-6).** `needOpp` on Review limited to unsure rows a pick can tick (or a link to lane 1); Review's header = `laneCount` | `src/components/time/{ToLogView.tsx,ReadyLane.tsx,review-derive.ts}`, `src/components/time/__tests__/review.dom.test.ts` | Review's "N rows" equals lane 2's at the same moment |
| F6 | **Also waiting up top, j/k in lane 1 (R2-7, R2-8).** Line between tabs and lanes; `RowGrid` in FixLane | `src/components/time/{ToLogView.tsx,FixLane.tsx}`, `src/components/time/__tests__/{to-log-view,activity-needs.dom}.test.ts` | The line is above the fold at 1440; j moves focus across a group header |
| F7 | **Polish (R2-11..14).** Current step label, Ready group toggle on the label, `accountOpp` dedup, live key by id, dead branches out of Q4Log | `src/components/time/{sending-derive.ts,SendingLane.tsx,ReadyLane.tsx,compact-derive.ts,FixLane.tsx,Q4Log.tsx}`, `tests/time/suggest.test.ts` | check:fast green; no "Hide" buttons on 1-row groups |

Manual checks for the owner after F1–F3: the AE overlay at scale 7 (`npm run smoke:crawl -- --mock --scale 7 --port
<lane> --persona ae`, then the shots), and one real Apply in dry run from Sending to confirm the batch line moves
Staged → Applied with the right-panel review unchanged.
