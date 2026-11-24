# Time redesign: one clear path (2026-11-11)

Owner feedback (an SE): the logging screen cuts off instead of wrapping; Week vs Log is hard to tell apart; too much
density; "I want to see what's been suggested, know what I need to do, and then know what the steps are for logging
it". He also could not tell that 31.8 h of a 44.25 h canvas landed in Q3 FY27, or that 14.5 h of Q4 still waited on
him: the header said only "12.5 of 250 h logged".

## Problems in the old layout

1. **Two tabs that both look like "the log".** Week held the quarter card with six numbered steps, a calendar grid and
   receipts, plus an editable table. Log held a quarter card and a denser table. Neither said what to do first.
2. **The table cut off.** The row grid had a fixed minimum of 72 rem (1,152 px). The page content is 1,144–1,152 px at
   1,280 and 1,440 with the panel closed and about 650 px with it open, so the right columns (status, source) were
   clipped, and descriptions and opportunity names were truncated to one line.
3. **Steps mixed two jobs.** "Approve", "Fix" and "Log / Apply / Confirm" sat in one list. Fixing rows (your input) and
   moving a batch through Slackbot (your clicks) are different jobs.
4. **The quarter number was not the whole truth.** It gave logged hours only: nothing about what was waiting on you,
   and nothing about a canvas whose rows were dated in the previous quarter.
5. **Too many simultaneous signals.** Every row had a bordered badge, bordered chips and a bordered CF/CR control. The
   status chips on Log were all bordered buttons with dots.

## The layout

Tabs say what they do. The URL params are unchanged (`view=week|log|vdp|forecast`), so every link still lands.

| Tab | `?view=` | What it is |
|---|---|---|
| **Log hours** | `week` (default for an SE) | The path: Suggested → Needs you → Log it, then the week's rows |
| **Ledger** | `log` | A quarter as a report (the current one by default, any past one, or all), then its rows, filterable |
| VDP / Forecast | `vdp` / `forecast` | Unchanged (Forecast stays the AE's default) |

**Log hours**, top to bottom (one column, full width):

1. **Quarter header** (the focal point, `data-testid="q4-log"`). Logged in Org62 against the target (with hours
   verified by read-back as a quiet caption), **waiting on you this quarter** (hours and rows, broken down by stage,
   linked to Needs you and Log it), pace, and **where a canvas's hours went** when its rows span quarters ("Activity
   log · 40 rows: 31.8 h landed in Q3 FY27, 12.45 h in Q4 FY27"). "Human hours only" is a quiet last line.
2. **1 · Suggested** (the selected week). What the app proposed, and how much: rows and hours, then where they are
   now as one line of counts (need you · ready · on its way · in Org62 · not logged), the CF/CR split, and the
   onsite chips with Mark trip. **Week at a glance** (the calendar grid) is a disclosure here, closed by default and
   remembered. Reasoning: the grid is evidence of what was suggested, not a task; closed, the whole path fits above
   the fold at 1,280 × 800; its summary line says what is inside, so nothing is hidden.
3. **2 · Needs you** (every open row of the quarter and the last three weeks). Rows that cannot log without you,
   grouped by what is missing, in this order: **No opportunity**, **No task type** (SE only), **Hours to check**
   (zero hours or a flagged duration), **Check and approve** (the engine's question: a placeholder, time off, a hold).
   Each row is in exactly one group (its first missing thing) and carries its fix inline: the opportunity picker,
   the type select, the hours field, Approve. Bulk fixes exist only where one pick fits many rows: the opportunity
   and the type, per cluster of rows from the same account or source ("Set opp for these 6 Slack rows"), with Undo.
   A fix that completes a row the engine held (`needs_input`) also approves it, so a fixed row moves to Ready in one
   click (the user's own input, and still nothing leaves before Log, Apply and Slackbot).
4. **3 · Log it** (`data-guide="log-steps"`). A stepper with four stops and a count at each:
   **Ready to log** (its verb is **Log to Slackbot**) → **Apply** → **Tell Slackbot** → **Verified**. Every arrow
   is one click of yours, so "Ready to log" and "Log to Slackbot" are one stop: the rows and the verb that moves
   them. Exactly one stop has the filled button: the first that needs you, in the old order (log, apply, tell); ⌘↵
   runs it. Secondary verbs are quiet: Approve N now, Log DCs now, Copy again. A row counts at one stop only (a
   logged row the read-back has not confirmed is on Tell Slackbot, not Verified). The stops sit in a row from
   60 rem, two by two from 30 rem (the panel open at 1,280–1,440), stacked below. Under the stepper, the applied
   canvases (receipts) as quiet lines with Open ↗, Copy prompt, the Org62 check and the quarter split.
5. **The week's rows**: the editable table of the selected week, grouped by day (a light day line, no boxes).

**Ledger** (2026-11-14, the owner: "more reporting and high-level than line-items"), top to bottom, over
`GET /time/ledger?quarter=` (one quarter, or `all`; none = the current quarter):

1. **Quarter picker**: the fiscal quarters oldest → newest, each with its hours in Org62 against the target, then All.
2. **Tracking**: in Org62 vs the persona's target (verified by read-back as a caption), hours to go, the pace (the
   current quarter), and one segmented meter by the one count map: in Org62 (done, green) · on its way (waiting,
   neutral) · suggested (AI) · needs input (amber). Waiting on you is Time's quarter truth (the same numbers as Log
   it), each part a link to where you act; a past quarter's opens its rows below. Excluded rows and the hours logged
   before the app's rows are counted apart. All: each quarter's line.
3. **Where the hours went**: by account with its opportunities (and its rows with none), internal work and rows with
   no account as their own lines, then by task type. Hours, rows, share, and a thin bar (in Org62, not yet).
4. **By week** (by quarter under All): one column per week, in Org62 at the baseline; a tooltip per column; Table.
5. **Rows**: the drill-down. A line or a week sets the list's filters (account, opportunity, `none`, `internal`, task
   type, week); a second click clears them. The status filters are quiet text toggles (only the selected ones get a
   fill); rows use the same wrapping grid as Log hours, and still open their details.

## Hierarchy and density

- One focal point (the quarter header), then numbered sections that read as the path. Sections with nothing in them
  collapse to one quiet line ("Nothing needs you").
- **One status column** with the label "Status": a status word, coloured only when it needs you (amber needs input,
  red missing, violet proposed); done rows read as muted text with a check. Source icons and the save state or the
  verified date are a quiet second line in the same cell.
- **Wrapping, not cutting.** The row grid follows its own container (`@container rows`): one line at 68 rem and wider;
  two lines from 44 rem (when · hours · description · status / type · opportunity · CF/CR); three lines below. The
  description is a two-line textarea that grows while you edit it; opportunity names wrap to two lines; both carry the
  full text as a tooltip. No horizontal scroll at 1,280, 1,440 or 1,920, with the docked panel open or closed.
- Fewer borders: no box per section (hairline dividers and space instead), day groups are a text line, the CF/CR
  control keeps its hairline only on the selected value, receipts are lines, not cards.
- Tokens and components only (`src/ui`, `src/components/domain`): no new colours. Colour is an indicator: blue is the
  one action, amber at risk, red broken, green done, violet AI; accounts and sources are neutral.

## AE

Forecast stays the AE's default view; Log hours reads the same path with Sales Events: no task-type group, no type in
the Ready rule, no type column needed (it reads "Not needed"), and no quarter target (hours alone, no pace).

## Data

One number was missing: where a canvas's hours went. `LogCanvas.quarters` (label, rows, hours per fiscal quarter of
its rows' days) is computed in the shared `logCanvasesOf`, so the mock and db DataSources return the same thing.
Everything else is derived on the client from the rows Time already loads (`src/components/time/path-derive.ts`).

## Left for later

- A row that logs to an account WhatId (no opp) still reads as "No opportunity": the contract has no WhatId kind.
- Keyboard flow inside Needs you (j/k across groups) reuses the table's keys only.

## Round 2 (2026-11-14): Needs you and Log it say what to do

Owner feedback: Needs you only offered an opportunity (Internal sat at the end of a long list, so rows could not be
fixed); rows showed the engine's canvas notes ("NEEDS WhatId: … write `=> 006…` or `=> skip`"); read-only states and
what "Log 2 items" took were unclear; every row should open to show how it came in and be editable there.

- **Plain English everywhere** (`src/lib/time-issues.ts`): each known engine note is one sentence that says what is
  off and what to do ("Slack work with no account: which opportunity, or internal?"); unknown ones lose the canvas
  syntax. The flags themselves are unchanged.
- **Suggestions** (D-71, `src/lib/time-suggest.ts`): rows that need an opportunity carry the app's suggestion (rules
  first, the cheap model for the rest), shown in the AI color with its reason, confidence and Accept. Never applied for
  you.
- **The picker** (`opp-picker-derive.ts`): Suggested → Internal (no opportunity) → the likely account's opportunities →
  accounts in its evidence → used lately → the rest; typed, the Org62 search is the first choice when nothing in the
  app matches. Wider (38 rem).
- **Needs you**: a selection bar (Select all, Select the rows with a suggestion, a group's Select these) with Accept N
  suggestions, Set one opportunity for N rows, Mark N rows internal, Set the type for N rows, Approve the complete ones.
  Each row: tick, when, hours (editable), what, opportunity, type; under it what is off and the suggestion, full width;
  the chevron opens how it came in (sources with links, why, how sure) and its other fields.
- **Log it**: Ready to log lists its rows (editable inline; tick to log only some) and the button names them ("Log these
  4 rows to Slackbot · 6.5 h"). Logging runs: each canvas is its own item (`rows-derive.ts` canvasRun): Staged → Apply →
  Tell Slackbot → In Org62 (a done step in the past tense, the next one as what happens next), its counts and Org62
  progress, why its rows are read only, and its one next action; finished runs (everything in Org62) fold under "Show
  N finished runs". A click opens the canvas in the panel, which shows the same run status above its review.
- **Details** (`ActivityPanel.tsx`): read only with its reason when it is, the suggestion, every field editable, the
  Description in Org62, how it came in, where it stands.

## Round 3 (2026-11-14): Activity, one job per tab, landings (D-70)

Owner asks: "Relabel the tab as Activity. Then we have Org62 as one tab (everything we have now + use cases) and VDP
another"; "separate what the app found this week into a new tab. Needs you should just be whatever I need to do. Same
with Log it. This week is irrelevant for either tab"; then "a tab that lets you select between different weeks … and I
click through them". Use cases log like anything else; updates read as history ("update · 2 h → 3 h").

The page is **Activity** at `/activity` (the sidebar entry too, chord `g l`). `/time` with any query redirects there
(`src/components/shell/routes.ts` redirectFor), so every old link lands. Two main tabs:

| Main tab | Sub-tab | `?view=` | What it is |
|---|---|---|---|
| **Org62** | **Log it** | `week` (SE default) | Only logging: the quarter header, Ready to log (rows, Event updates, use cases), Logging runs (each canvas with its writes), Internal, Use cases in Org62 |
| | **Needs you** | `needs` | Only what needs you, across the quarter: the rows grouped by what is missing, then the use cases with a question. No week |
| | **Weeks** | `weeks` | The week picker, what the app found that week (Suggested, onsite days, Week at a glance), the week's rows (j/k, Enter) |
| | **Ledger** | `log` | Unchanged (a quarter as a report, then its rows) |
| | **Use cases** | `usecases` | Each use case in Org62 and VDP: neither, one or both, where they differ, its assets and writes (VDP feature) |
| | Forecast | `forecast` | Unchanged (the AE's default) |
| **VDP** | Changes · My VDPs | `vdp` (`&sub=mine`) | Unchanged |

- **`?week=` opens Weeks.** A link with `?week=` and no view, or Log it's or Needs you's view (the old deep links), is
  Weeks on that week (`timeViewOf`). "Show it in the week" from Log it, Needs you or a panel opens Weeks with
  `&row=<id>`, and the row lights up.
- **The week picker** (`weeks-derive.ts`): the weeks of the current fiscal quarter and the one before, grouped by
  quarter and scrollable sideways; each chip is the week's Monday, the hours the app found that week, how many are in
  Org62 ("3.5 / 6 h") and a thin bar of that share. The current week is the default and carries a small "this week"
  marker. A chip opens its week; the arrows and This week in the header step as before.
- **Ready to log** lists three kinds, each ticked the same way: the rows; **updates to Events already in Org62**
  ("Discovery call · update · Duration 2 h → 3 h", proposed by the re-derive: Approve or Dismiss, or just log it, since
  a complete proposed update is approved with the batch like a complete row); and **use cases ready for Org62** (their
  title, company · opp · what goes: "New in Org62 on <opp>" or "Stage U03 → U05", their "Org62 — · VDP ✓", Leave out).
  The button names what it takes: "Log 3 rows, 2 use cases and 1 update to Slackbot · 4.5 h". Use cases alone make a
  canvas; DC requests still ride along.
- **Logging runs**: each run's **Its writes** opens every create, update and delete it carries exactly as sent, with
  the rows taken off before Apply kept as removed; the draft panel shows the same list under the run status (open by
  default once applied).
- **Needs you ▸ Use cases**: a use case that asks something: the opportunity it goes on (one button per open opp with
  your 100% DC), a name while VDP has none, an account, your DC (a link to Deals ▸ DCs), or a value to pick where both
  systems changed. Each answer is one undoable change; the use case then moves to Ready to log.
- **Use cases** tab: filters (All · In both · Org62 only · VDP only · In neither · Differ · Ready to log · Need you),
  the use cases grouped by company, each with "Org62 ✓ · VDP —" and its state. Open one: both landings side by side
  with the values each system holds, the question, **Where Org62 and VDP differ** (field, Org62, VDP, which side changed
  since they agreed, Use Org62's / Use VDP's, and what happens next), its assets (VDP only, each "In VDP", "Added:
  waiting for the VDP read" or "Suggested"), and every write that put it there.
- **The details panel** of a row gains **Where it landed**: "Org62 ✓" and the Event id, then every write ("create ·
  Duration 2 h" on the first canvas, "update · Duration 2 h → 3 h" on a later one), each with its canvas and why.
- Color is the state only: in the system green, differs amber, missing red, staged neutral (dashed), sent the one in
  progress (blue), never sent neutral; a proposed update is a suggestion (AI color).
