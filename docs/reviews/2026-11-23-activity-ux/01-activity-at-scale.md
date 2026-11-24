# Activity at scale: To log, History, and the dense pages (review + proposal)

- **Date:** 2026-11-23 · **Lane:** activity-ux-review (review and proposal only; no application code changed)
- **Reviewed build:** Command Center 2.0.0 `d0f1878` (the mock production server on :4327 and its checkout). This
  worktree's branch is the v1.3 scrubbed snapshot, which has neither `ToLogView.tsx` nor D-87; every path and line
  below refers to the 2.0 tree (`src/components/time/**` at `d0f1878`).
- **Evidence:** screenshots at 1440 and 1920 of `/activity`, `?view=history`, `?review=1`, `?show=week` on :4327
  (example seed), and the same at scale on a private lane server (:4361, `CC_DATA=mock`, `CC_SEED_PATH` = the example
  seed with its activity multiplied to 144 rows over seven weeks: 40 need input, 39 proposed, 16 handed to Slackbot,
  16 not found in Org62, 8 approved; work items tripled to 108). VDP items come from `src/mock/vdp.ts`, not the seed,
  so VDP at 60+ is reasoned from code, not seen. Screenshots stay in `.shots/` (not committed).
- **Brief:** the owner's three jobs (quoted in the lane brief): **J1** check or fix the time and its auto-attribution
  (opp/account, look it up in Org62), approve; **J2** see what's approved and waiting to be logged; **J3** track one or
  more logs to completion and see what's already logged.

---

## 1. Inventory: To log today, top to bottom

Measured at 1440 × 900 with the assistant panel closed. "Example" = the shipped example seed; "scale" = 144 rows.

| # | Section (code) | What it shows | Action it asks for | With 50+ rows | Also shown elsewhere |
|---|---|---|---|---|---|
| 0 | Header sentence + List/Week + "Review N to log" (`ToLogView.tsx` `sentence`, `ActivityHead.tsx`) | "Q4 FY27 · 12 rows ready to log (11 h) · 36 rows and 4 use cases need you" | Review N to log (the one filled button) | One line, fine | Counts repeated in 1, 2, 3, the tab badge and the sidebar, each a different number (AX-2) |
| 1 | **Needs you here** (the D-86 queue slice, `ActivityNeedsSlot` in `ActivityHead.tsx`) | Top 3 of the queue: DC claims, "Log 79 rows of activity (105 h): 56 need a fix · 15 to approve · 8 ready", use cases to add; "See all 12 →", "Review 4" | Claim / Not my account, Fix rows / Later, Add / Not a use case | Fixed at 3 rows + link; the time row is a roll-up whose counts do not match sections 3 and 4 | Home's Needs you block (by design), and **inside this page**: sections 3 (rows), 5 (DCs), 6 (use cases to add). Pure duplication on one page |
| 2 | **Quarter card** (`QuarterHeader.tsx`) | 27.5 h of 60 h, pace, due date; "Waiting on you this quarter: 82.75 h · 61 rows (54.75 h need you · 11 h ready · 17 h to send via Slackbot)"; red **Not in Org62 yet** strip "11 h approved, not in Org62 … 10 rows missing" + Show them | Jump links; Show them | Fixed height (~300 px); fine | **History tab** repeats the same tracking card (`LedgerTracking`) with the same "Waiting on you" block; "Not in Org62" is also group 3a and a History row state |
| 3 | **Needs you** `#time-needs` (`NeedsYou.tsx`) | Select bar ("Select all 26", "Select the 21 rows with a suggestion"); groups: **Not in Org62** (Log again / Leave out), **No opportunity** (opp picker, type picker, hours, AI suggestion block with Accept and "the likely opps"), then other missing-field groups | Fix each row inline, Accept suggestion, multi-select bulk set opp | Every row rendered (~180 px each, suggestion block open by default); pages only after **50 per cluster** (`useShowMore(…, { step: 50 })`, `NeedsYou.tsx:248`). At scale this section is **~6,000 px** (seven screens) | Not-in-Org62 rows also in quarter card (2) and History; the same rows again on Review (`?review=1`) and in the Week view |
| 4 | **Ready to log** `#time-ready` (`Q4Log.tsx` → `ReadyToLog.tsx`) | By day: each approved row with opp + type pickers, then use cases and Event updates; "Review N to log · h" + "Approve 1 now" | Review → one batch | Pages after 50 (`ReadyToLog.tsx:84`); starts **~7,000 px** down at scale | Header button; Review page is the same list with checkboxes |
| 4b | **On its way to Org62** `#time-runs` (`CanvasRuns.tsx`, inside LogIt) | Each batch: Staged → Apply → Send to Org62 via Slackbot → checked in Org62; finished runs folded ("Show N finished runs") | Apply, open canvas | Grows one card per open batch; finished folded | **History** rows show the same rows as "On its way to Org62 via Slackbot · Unconfirmed · Undo"; quarter card's "17 h to send via Slackbot". Progress is told three times |
| 5 | **DCs to claim** `#time-dcs` (`DcSuggestions.tsx`) | Deal-contribution suggestions with Accept/Edit/Reject, "Claim N DCs" | Claim | Unpaged list | Section 1 (Claim rows), Deals ▸ DCs (`src/components/deals/DcView.tsx`), Home |
| 6 | **Use cases** `#time-usecases` (`UseCaseCandidates`, `UseCaseQuestions`, `UseCaseSync`, `UseCaseList` in a `<details>`) | Candidates to add, use cases with a question (a field-diff table), "Use cases in Org62" drift, "Every use case, in Org62 and VDP" (collapsed) | Add / It goes here / Use Org62's / Use VDP's / Leave it | Unpaged; each question card is ~250 px | Section 1 (Add use case rows); VDP tab (the same use cases as VDP items); `update_use_case` items in the VDP tree |
| 7 | **Internal (no opportunity)** `#time-internal` (`InternalRows.tsx`) | Work for no customer: type picker, Log / Dismiss / More; Log all / Dismiss all | Log or dismiss | Unpaged; at scale ~1,500 px at the very bottom | Ledger "Internal" line |

Other views of the same tab:

- **Week** (`?show=week`, `WeekView.tsx`): the Needs-you-here slice again, a week strip, "What the app found", Week at a
  glance, then that week's rows. Useful for "what did I do Tuesday", not for logging.
- **Review** (`?review=1`, `LogReview.tsx`): one page of checkboxes by day, "Log these N · h". At 1920 × 1080 with 37
  rows only **four rows fit**: a "Guess" row expands its two candidate opps inline (~250 px), and the row spans the full
  1,620 px width with the right 40% empty.
- **History** (`?view=history`, `ActivityLogView.tsx`): quarter picker, the tracking card (again), Where the hours went,
  By week, Every row (virtualized, filters, grouped by week and day, rows editable inline for open states).
- **Sidebar ▸ History** (`/history`, `src/components/history/HistoryPage.tsx`): a month calendar and a day journal,
  "Time logged · Meetings · Agent runs". A second page called History.

**Duplication, named plainly**

1. **"Needs you here" vs Needs you / DCs to claim / Use cases** on the same page: the same items as a 3-row roll-up and
   then in full, with different counts.
2. **The quarter card on To log and on History**, both with "Waiting on you".
3. **"On its way to Org62" (To log) vs History's handed-off rows vs the card's "to send via Slackbot"**: one batch's
   progress, three places, three phrasings.
4. **"Not in Org62"**: the card's red strip, Needs you's first group, and History's red row badge.
5. **History tab vs the History page**: two things called History; the owner's "history in two pages" is literal.
6. **Ready to log vs Review**: the same list twice, one editable, one tickable.
7. **DCs to claim** on To log and Deals ▸ DCs and Home; **use cases** on To log and on VDP.

---

## 2. Findings

Severity is against the brief: blocker = a job can't be done at scale; high = a job is slow or error-prone at scale;
medium = clarity; low = polish.

**AX-1 · blocker · The page answers "what do I do?" seven screens down.** At scale nothing actionable on time rows is
above the fold at 1440 × 900: the fold holds the header, the 3-row queue slice and the quarter card. Needs you starts
at ~1,000 px and runs ~6,000 px; Ready to log (J2) starts at ~7,000 px; batches in flight (J3) follow it. Cause:
`ToLogView.tsx` stacks seven sections in one column, every row renders its pickers and suggestion block open, and the
paging step is 50 per cluster (100 kit default, `src/ui/ShowMore.tsx`), so a 40-row backlog never pages.

**AX-2 · high · The counts disagree, so the user can't trust any of them.** Same moment, scale seed: header "12 ready ·
36 rows need you"; tab "To log 40"; sidebar "Activity 7"; queue slice "79 rows: 56 need a fix · 15 to approve · 8
ready"; quarter card "11 h ready · 11 rows", "36 rows need you", "14 rows to send"; select bar "Select all 26" under
"36 rows". Example seed: header 3 ready, card 2 ready, slice 1 ready. Each surface counts a different set (proposed
rows are "to approve" in one, "ready" in another; Not-in-Org62 counts as needs-you but can't be selected). Code:
`needsYouCount` (`src/engines/activity/needs-count`), `QuarterHeader` truth, the D-86 queue's time roll-up, and
`NeedsYou`'s `fixable` (excludes the org62 group).

**AX-3 · high · J1 (fix attribution) is buried in a tall row.** Each needs-you row is ~180 px: title, two pickers, a
warning line, a purple suggestion box with Accept and "Not sure? See the likely opps". At 40 rows that is the page.
The opp/account and "look it up in Org62" exist (picker search, "the likely opps") but you must scan each card; there
is no compact "row · suggested opp · confidence · Accept" line you can sweep and bulk-accept. "Select the 21 rows
with a suggestion" exists but sits in a bar above 6,000 px of rows; the accept-all verb is not where the eye is.

**AX-4 · high · J2 (approved, waiting to log) has no home of its own.** "Ready to log" is section 4, below the full
needs-you list; the same rows are re-listed on Review; "Approve 1 now" mixes proposed rows in. The user can't answer
"what have I approved that isn't logged yet?" in five seconds.

**AX-5 · high · J3 (track logs to completion) is split across To log, History and the card.** A batch's life (staged
→ applied → sent via Slackbot → checked in Org62 / not found) shows as a run card in "On its way to Org62"
(`CanvasRuns.tsx`), as per-row "Unconfirmed / On its way… / Undo" on History (`HistoryParts.tsx`), as "17 h to send"
on the card, and its failures as a red strip on the card plus a needs-you group. There's no single "Batches" list
where one batch reads as one line with a progress state.

**AX-6 · high · "Failed" has three looks and no single place.** A row that didn't reach Org62 is: a red "Not in Org62
yet" strip (card), a "Not in Org62" group with Log again / Leave out (Needs you, *first*, above the attribution work),
and a red badge on History. A batch that failed (canvas never applied, expired after 14 days, Slackbot run without
rows) is only a run card state. The user can't tell "what failed" from "what's waiting".

**AX-7 · medium · Two Histories.** Sidebar ▸ History (`/history`, day journal) and Activity ▸ History (ledger). The
day journal's "Time logged" is a third count of the same hours.

**AX-8 · medium · One column at any width.** At 1920 with the assistant closed the content is a 1,620 px single column;
rows run edge to edge with the right 40% empty (Review especially). The kit has no two-column page frame;
`#cc-main[data-panel]` (`src/components/shell/panel.tsx`) already says whether the right panel is open, which is the
switch the owner asked for.

**AX-9 · medium · Dive deeper is three different affordances.** A row title opens the details panel (`useRowNav`
`openRow`); "See all 12 →" navigates; "Show them" jumps in-page; "Not sure? See the likely opps" expands inline;
Review expands candidates inline; `<details>` hides every use case. No row has a visible chevron saying "more here".
Note the details panel and the Assistant share the same right panel (`RightPanel.tsx`, 520 px): opening details
**is** the one-column state.

**AX-10 · medium · Use cases and DCs crowd the logging page.** Sections 5 and 6 are their own jobs (deal hygiene,
VDP/Org62 drift) with their own question cards and field-diff tables; at scale they push Internal to ~11,000 px.

**AX-11 · low · Plain words regress at the edges.** "Send to Org62 via Slackbot", "CF 0 h · CR 0 h" (Week), "Not in
Org62 yet" vs "Not in Org62" vs "missing in Org62" vs "Deleted in Org62" for neighbouring states.

**The three jobs, at scale, under five seconds?**

| Job | Where today | Under 5 s at 40+ rows? |
|---|---|---|
| J1 fix/approve time + attribution | Needs you (section 3), each row's card; also Review | **No.** Visible, but one tall card per row; no sweepable list |
| J2 what's approved and waiting | Ready to log (section 4, ~7,000 px down), Review | **No.** Below the fold by several screens; counts disagree |
| J3 track logs, see history | Runs (4b), History rows, card, Not-in-Org62 group | **No.** Split across three places and two tabs |

---

## 3. Proposed To log layout

**Headline: To log becomes a three-lane board, "Fix · Ready · Sending", one count each, with the full history and
its charts on History only.** One lane per job, each with one obvious button, compact rows, the details panel for
anything deeper.

### 3.1 Assistant collapsed (1440 wide; main ≈ 1,200 px): header + two columns

```
┌ Activity ─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Q4 FY27 · 27.5 of 60 h in Org62 · on pace · due Thu 12:00        [List|Week]       ▸ History          │
│ To log 3 lanes   History   VDP 6                                                                       │
├───────────────────────────────────────────────────┬───────────────────────────────────────────────────┤
│ 1  FIX OR APPROVE   36 rows · 54.75 h             │ 2  READY TO LOG   11 rows · 11 h                  │
│ [✓ Accept 21 suggestions]  [Set opp for ticked ▾] │ [Log 11 · 11 h]  (one batch, you Apply it)        │
│ Group: Opportunity ▾  Day | Account | Opp  ⌕      │ by day                                            │
│ ── Suggested: Globex · Data 360 Expansion (9) ─── │ ── Fri 20 Nov · 2 rows · 2 h ─────────────────────│
│ ☐ Thu 19 · Data 360 roadmap call   1 h  87% ✓  › │ ☑ 15:30 SOW pricing model  1 h  Globex · D360  › │
│ ☐ Sat 21 · Globex arch call        1 h  76% ✓  › │ ☑ 17:30 NCE evaluation     1 h  Hooli · NCE    › │
│ … 7 more in this group                 Show 7 ▾  │ ── Sat 21 Nov · 3 rows · 6 h ─────────────────────│
│ ── Suggested: Internal (5) ────────────────────── │ …                                                 │
│ ☐ demo-kit: internal asset build   1.5 h  ✓     › │ 6 more days                        Show all ▾     │
│ ── No suggestion: pick an opp (8) ─────────────── │                                                   │
│ ☐ Claude: member data model draft  1.5 h [Pick ▾]›│ 3  SENDING   2 batches · 17 h                     │
│ ── Missing a task type (6) · Hours to check (4) ─ │ ● Batch 21 Nov · 14 rows   Waiting for your Apply │
│   (collapsed group headers with counts)           │                                  [Apply]        › │
│                                                   │ ● Batch 19 Nov · 6 rows  Sent · 4 of 6 checked    │
│                                                   │   ▲ 2 not found in Org62  [Log again] [Leave out]›│
│                                                   │ Finished this week: 3 batches ▸ History           │
├───────────────────────────────────────────────────┴───────────────────────────────────────────────────┤
│ Also waiting: 2 DCs to claim ▸ · 4 use cases ▸ · 3 internal rows (in lane 1 above)                    │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Above the fold at 1440 × 900: the header line, all three lane headers with their counts and their one button, about
eight rows of lane 1, six of lane 2 and lane 3's open batches. Below the fold, each lane scrolls in its own column (the
page scrolls; the lane headers are sticky).

### 3.2 Assistant or details panel open (1440 wide; main ≈ 680 px): one column

```
┌ Activity ─────────────────────────────────────┐ ┌ Details / Assistant (520) ┐
│ Q4 FY27 · 27.5 of 60 h · on pace · due Thu    │ │ Data 360 roadmap call     │
│ To log   History   VDP 6                      │ │ Thu 19 Nov 08:00 · 1 h    │
│ [Fix 36] [Ready 11] [Sending 2]   ← lane pills│ │ Suggested: Globex · D360  │
├───────────────────────────────────────────────┤ │ Why: globex.example was   │
│ ▾ 1 FIX OR APPROVE · 36 · [Accept 21]         │ │ there; logged last Nov 20 │
│ ☐ Data 360 roadmap call  1 h  Globex 87% ✓  › │ │ Other likely opps (2)     │
│ … (8 rows, then Show N)                       │ │ [Search Org62 opps ⌕]     │
│ ▸ 2 READY TO LOG · 11 · [Log 11 · 11 h]       │ │ Opp ▾  Type ▾  Hours      │
│ ▸ 3 SENDING · 2 batches · ▲ 2 not found       │ │ [Accept] [Internal]       │
└───────────────────────────────────────────────┘ └───────────────────────────┘
```

The same three lanes stacked; the pills jump to a lane and say its count; the lane with work opens, the others show
their header line (count, failure mark, button) collapsed. Opening a row's details is the one-column state, so the
row stays visible beside its panel.

### 3.3 What moves, what goes, what becomes a count

| Today | Proposal |
|---|---|
| Needs you here (queue slice) | **Removed from To log.** Its time row is the page itself; its DC and use-case rows are the "Also waiting" line. The slice stays on Home and on pages whose work is not the page (D-86 conflict: see §6) |
| Quarter card | **One header line** ("27.5 of 60 h in Org62 · on pace · due Thu 12:00"); the full tracking card lives on History only |
| Not-in-Org62 strip + group | **Lane 3**, on the batch it came from, with Log again / Leave out; lane 3's header carries "▲ N not found" |
| Needs you (section 3) | **Lane 1**, compact rows (one line, ~44 px), grouped by suggestion |
| Ready to log (section 4) + Review page | **Lane 2**; ticking is on the lane itself. Review (`?review=1`) becomes lane 2 at full width (or is retired; owner call) |
| On its way to Org62 (4b) | **Lane 3**; finished batches go to History |
| DCs to claim (5) | A count on "Also waiting" linking to Deals ▸ DCs (their page) |
| Use cases (6) | A count on "Also waiting" linking to the use cases view (VDP tab or a To log filter); the question cards and drift tables move with it |
| Internal (7) | Folded into lane 1 as the "Suggested: Internal" group (Accept = log as internal) |

### 3.4 Scale rules

- **Rows.** One line per row: checkbox · day/time · title · hours · where it goes (account · opp, or the suggestion
  with its confidence in the AI colour) · one verb · chevron `›`. Pickers appear only on the row being edited (focus or
  click on "where it goes"), not on every row.
- **Default rows per group: 8**, then "Show N more in this group" and "Show all N"; a lane shows at most 4 groups
  open, the rest as headers with counts. The kit's `useShowMore` gets a `step: 8` call site, not a new mechanism.
- **Group-by**: lane 1 defaults to **by suggestion** (same proposed opp together: "Suggested: Globex · Data 360
  Expansion (9)" → one Accept for the group), then "No suggestion", "Missing a task type", "Hours to check". A
  toggle offers Day | Account | Opportunity. Lane 2 defaults to **by day** (how Org62 will read it); Account is the
  alternative. The choice is per viewer (localStorage, wrapped in try/catch).
- **Needs-you ordering** (lane 1): rows whose quarter is due soonest first; within that, groups with the highest
  confidence suggestion first (fastest wins first), then the largest hours; within a group, oldest first.
- **Multi-select and bulk**: checkbox on every row and on every group header (ticks the group); shift-click ranges;
  `x` ticks the focused row. The lane's sticky bar shows "N ticked · h" and the verbs for that lane only: lane 1
  **Accept suggestions · Set opp ▾ · Internal · Leave out**; lane 2 **Log N · h** (stages one batch: D-47) and **Move
  back to fix**; lane 3 **Log again · Leave out** on not-found rows. The lane header's button with nothing ticked acts
  on the obvious set ("Accept 21 suggestions", "Log 11"), with the count in the label.
- **Failed** looks the same everywhere: a red `▲` and the plain reason on the row ("Not found in Org62 after the
  batch ran", "Deleted in Org62"), and on its batch line ("▲ 2 not found"). A batch that failed as a whole (expired
  without Apply, Apply refused by the recheck, read-back failed) is a red batch line in lane 3 with its one fix
  ("Apply again", "Review it", "Re-check Org62"). Failures never appear in lane 1 or 2; lane 3's header carries the
  count so it's visible when collapsed.
- **Dive deeper**: one affordance, the row chevron `›` (and Enter, and a click on the title) opens the details panel:
  the evidence, the "why this opp", the other likely opps, Org62 search, the Description note, the batch history of
  the row. No inline expanders on rows; no new pages. A batch line's chevron opens the batch in the same panel (its
  rows and its writes as sent).
- **Counts**: one number per lane, computed by one function, and the tab badge = lane 1 + lane 3 failures (what needs
  you). The header sentence, the sidebar and Home's time row read the same function (AX-2).
- **Layout switch**: two columns when `#cc-main[data-panel="closed"]` and main ≥ 1,100 px; one column otherwise.
  Built as a kit frame (container query on main), not per page.

---

## 4. History

**Belongs there and only there:** the quarter tracking card (target, pace, the meter), Where the hours went, By week,
every row of the quarter with its Org62 record, corrections to Events already in Org62, and **finished batches**
(everything in Org62, or left out). Not on History: anything still waiting on the user.

**In-flight progress shown once:** a batch lives in To log ▸ Sending until every row is checked in Org62 or settled
(logged again / left out); then it moves to History ▸ Batches. History's row list marks handed-off rows quietly
("in batch 21 Nov") with a link to the batch in lane 3, instead of its own "On its way… / Unconfirmed / Undo" state.

**Tracking one or more logs to completion:** each batch is one line with a four-step progress ("Staged · Applied ·
Sent · Checked 4 of 6"); the batch's chevron opens its rows in the details panel. Several batches stack in lane 3,
newest first. History gets a "Batches" filter chip next to its status chips, so a finished batch's rows can be found
by batch.

**Two Histories:** keep one name per page. The sidebar page is a day journal of everything the app saw (meetings,
agent runs); rename its nav label to "Journal" (or fold it into Today's past days), and stop it repeating "Time
logged" totals, linking to Activity ▸ History instead. This changes navigation copy, not the number of pages; owner
call.

---

## 5. The same rules on the other dense pages

Pattern: **lanes by what the user does next, one count and one button per lane, compact rows grouped with a default
of 8, a sticky bulk bar per lane, failures in their own lane, the chevron opens details, two columns when the
assistant is closed.**

- **Inbox / Needs you (dozens of DMs and emails).** Lanes: **Reply** (drafts ready to review, by person/thread) ·
  **Decide** (questions, confirm-a-guess, looks done) · **Failed / bounced** (a draft that didn't send, a decision
  that errored). Group by account or by person; 8 per group. Bulk: Later, Dismiss, Approve drafts the user has
  already read. The queue's ordering (D-86: urgency, then oldest) stays; rows stay one line with the D-86 verbs and
  keys.
- **VDP (60+ items).** Today a Company → VDP → item tree with every node open. Lanes: **Can push now** (ticked, "Push
  N to VDP") · **Needs a value or a decision** (identity, inputs) · **Pushed / failed** (push runs, autopilot's
  applied items, a failed push with its reason). Group by company, collapsed to "Globex · 7 items · 5 pushable" with
  a group tick; 8 companies open, the rest as headers. The node's chevron opens the company in details (identity
  dialog stays). My VDPs stays a filter.
- **Work.** Lanes: **Do today** · **Waiting on someone** · **Looks done?** Group by account; 8 per group; bulk
  Snooze / Done; details panel for the item. Done items go to the History journal, not Work.

---

## 6. What stays, and conflicts

What stays (and why):

- **Nothing leaves without approval** (tenet; D-47): lane 2's "Log N" stages one batch, the user Applies it on the
  batch line (or in the Outbox) with its preview, confirm, dry run and audit unchanged. Lane 3 shows Apply; no new
  write path.
- **D-87** (To log · History · VDP, use cases as rows, plain words): the three tabs stay; To log keeps "what the app
  can log and what it needs from me".
- **D-65** (round trip): Log again / Leave out, the preflight recheck and "never hide a real Org62 record" are kept;
  they move to lane 3.
- **D-64** (internal activity never asks for an opp, never in needs-you counts): the "Suggested: Internal" group in
  lane 1 is a proposal to accept, not a needs-you row; it must not count in the tab badge. Keep that rule explicit.
- **D-70** (landings and writes): the batch details panel shows "its writes as sent" from `landing_writes`.
- **D-71** (suggestions never applied for the user): group Accept is still the user's pick, with Undo.

Conflicts to raise (**blockers for the owner, not resolved here**):

1. **D-86 / UX "Needs you: one queue"** says Activity's "Needs you here" slice is the first section under To log's
   tabs. The proposal removes it from To log (it duplicates the page). Owner decision needed: amend D-86 so pages
   whose content *is* the queue's slice don't mount it.
2. **D-87 / D-72 history: DCs and use cases on To log.** D-72/D-87 put "DCs to claim" and use cases on Log it / To log.
   The proposal reduces them to a count linking elsewhere. Needs an owner yes, and a decision on where the use-case
   question cards live (VDP tab, or a To log filter).
3. **D-64** put Internal as its own quiet group on Log it; folding it into lane 1 changes where it shows (not its
   counting). Low risk, still a decision change.
4. **Renaming the sidebar History** touches navigation (D-86's nav part). Owner call.
5. **Review page**: retiring `?review=1` would break the "one page of checkboxes" D-87 named. Keep it as lane 2
   full-width unless the owner says otherwise.

---

## 7. Build plan (each chunk ≤ 45 min, Opus builder; after the owner settles §6)

Tests: fold new cases into existing files (ENG-5 fan-out ratchet, `tests/hygiene/engine-fanout.test.ts`); keep
`tests/ui/time-plain-words.test.ts` green and add the new copy to it.

| # | Chunk | files: | Tests to touch | Depends on |
|---|---|---|---|---|
| C1 | **One count.** A pure `lanesOf(path, runs)` → {fix, ready, sending, failed} used by the header, tab badge and lane headers; the queue's time row reads it too | `src/components/time/{lanes-derive.ts,ToLogView.tsx,ActivityTabs.tsx}`, `src/engines/activity/needs-count*` | `tests/time/needs-count.test.ts`, `src/components/time/__tests__/to-log-view.test.ts` | none |
| C2 | **Kit: two-column page frame.** `LanePage` with sticky lane headers, switches on `#cc-main[data-panel]` + container width | `src/components/kit/{LanePage.tsx,index.ts}`, `src/components/kit/__tests__/*` | existing kit tests (add cases), `tests/a11y` baseline check | none |
| C3 | **Compact row.** One-line `ActionRow` variant for activity rows: suggestion with confidence, one verb, chevron → details | `src/components/time/{RowParts.tsx,NeedsYou.tsx}`, `src/components/kit/ActionRow.tsx` | `__tests__/activity-needs.dom.test.ts`, `tests/time/suggest.test.ts` | C2 |
| C4 | **Lane 1: Fix or approve.** Group by suggestion (default) / day / account / opp; 8 per group; group tick; Accept N; Internal folded in | `src/components/time/{NeedsYou.tsx,InternalRows.tsx,review-derive.ts,bulk.ts}` | `tests/time/internal-activity.test.ts`, `tests/time/review.test.ts` | C1, C3 |
| C5 | **Lane 2: Ready to log** with ticks and "Log N · h"; Review becomes lane 2 full width | `src/components/time/{ReadyToLog.tsx,Q4Log.tsx,LogReview.tsx}` | `__tests__/review.dom.test.ts`, `tests/time/canvas-review*.test.ts` | C1, C3 |
| C6 | **Lane 3: Sending.** One line per batch with steps and checked x of y; not-found rows on their batch with Log again / Leave out; batch-level failures | `src/components/time/{CanvasRuns.tsx,RelogActions.tsx,QuarterHeader.tsx}` | `tests/time/roundtrip.test.ts`, `tests/time/applied-canvases.test.ts` | C1 |
| C7 | **To log assembly.** Header line instead of the card; three lanes in `LanePage`; "Also waiting" line; drop the queue slice (only if §6.1 is approved) | `src/components/time/{ToLogView.tsx,ActivityHead.tsx,views.ts}` | `__tests__/to-log-view.test.ts`, `tests/time/views.test.ts`, `tests/ui/time-plain-words.test.ts` | C4–C6, owner on §6 |
| C8 | **History owns the past.** Batches filter, finished batches list, quiet "in batch" row state | `src/components/time/{ActivityLogView.tsx,HistoryParts.tsx,history-derive.ts}` | `tests/time/history.test.ts`, `__tests__/log-view.test.ts` | C6 |
| C9 | **Smoke at scale.** A `--scale` option on the example seed (rows ×7, work ×3) for `smoke:crawl` and `shot` | `scripts/seed/**` (or `scripts/stress/**`), `src/mock/**` | `tests/mock/*` existing | none |

Order: C1, C2, C9 in parallel → C3 → C4, C5, C6 in parallel → C7 → C8. Then the same frame for VDP, Inbox and Work as
their own briefs.

---

## Appendix: how the scale view was made

A script in the scratchpad copied the example seed's 18 activity rows seven times (shifted −35 to +2 days, every
other copy of a logged/verified row turned into needs-input with no opp) and tripled the work items; a copy of the
2.0 tree ran `next dev` on :4361 with `CC_DATA=mock`, `CC_STATE_DIR` in the scratchpad and `CC_SEED_PATH` at that
file; screenshots via `scripts/shot.mjs`. GET only; the server was stopped afterwards. C9 makes this repeatable.
