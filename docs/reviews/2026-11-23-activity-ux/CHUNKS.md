# Activity at scale: the build ledger

Decision: [D-102](../../decisions/0102-activity-lanes.md). Plan: [review 01 §7](01-activity-at-scale.md). Every lane an Opus builder in its own worktree, time-boxed; merged here with the merge verified (typecheck, the touched suites).

| Chunk | What | Status | Merged at |
|---|---|---|---|
| review | Inventory, scale screenshots (144 rows), findings AX-1..11, the three-lane proposal | done | 7ef192b |
| upgrading-doc | `docs/UPGRADING.md`, the 1.x → 2.0 path end to end, UPG-1..8 | done | dac54b9 |
| upg-fixes | UPG-3 (migrated web binds 127.0.0.1; doctor fails otherwise), UPG-4 (pre-major dump kept), UPG-8 (`--check` names the database) | done, rehearsed on a scratch HOME | 239f323 |
| C1 one count | `lanesOf` feeds header, tab, lane headers, Select all, the queue's time row | done | d854520 |
| C2 lane frame | kit `LanePage`: two columns when `#cc-main[data-panel="closed"]` and main ≥ 1,100 px, pills in one column, `/dev/kit/lanes` | done | 2d833e1 |
| C9 scale seed | `CC_SEED_SCALE=n`; at 7: 126 activity rows, 127 work items, 74 VDP items; crawls 43/43 both personas | done | e11d8f3 |
| C3 compact row | `ActionRow` density compact/group, `CompactActivityRow`, `CompactGroupHeader`, editor on the edited row only | done | 5958212 |
| C5 Ready lane | `ReadyLane` by day/account, ticks on the lane, "Log N · h" stages one batch (D-47), Review = the lane full width | done | b9821ea |
| C4 Fix lane | `FixLane` grouped by suggestion, group Accept, 8 per group, bulk verbs, Internal as a group outside the count | done | 438bab9 |
| C6 Sending lane | `SendingLane`: one line per batch with four steps, not-found rows under their batch, failures only here; the queue row sees batches; scale seed has batches | done | 3033735 |
| C7 assembly | LanePage with the three lanes, header sentence, Also waiting line (DCs and use cases in folds), no queue slice, queue row = lanesOf; sidebar badge still on the old count (contract) | done | 07af17e+ |
| C8 History | History owns the past (card, finished batches, `?batch=` chip, in-batch state); sidebar History → Journal | done | 07af17e |
| C10 follow-ups | sidebar badge from one shared rule (`to-log-count.ts`), one filled button, settled batches finish, `?batch=` kept, `shot --open-panel` | done | 50c2a5a |
| review 2 | Fable delta review at scale 7: fix first; R2-1 blocker (queue vs page row sets), R2-2..14 | done | 9e807a1 |
| F6 | Also waiting above the lanes; j/k in lane 1 | done | 0aa6307 |
| F2 | compact row widths at 1440 (title 24+ chars, short failure reasons) | done | f5e132a |
| F3 | lane 2 header and button tell one story; folded extras unticked; Approve-now and Last-batch gone | done | b21a745 |
| F1 | one row set (`to-log-rows.ts`): queue row = badge = tab = lane 1 + failures; older quarters shown first | done | b36d889 |
| F5 | Review = lane 2 at full width, same header; a link to Fix for rows needing an opp | done | a09627a |
| F7 | batch labels with time, filled step = current, short reasons, editor survives a group change, dead code out | done | 6d4c853 |
| F4 | one batch label and row count everywhere; the card drops the in-flight story | done | 9030a46 |
| C11 org62-first-class | everything bound for Org62 in lane 2 (time rows, DCs, use cases, Events, each with a count and a tick); lane 1 splits into Accept (sure) and Review (grayed, never in Accept N); a time answer re-runs the DC suggestions | done | aea01dd (merged be753a5) |
| WO-1 canvas-tables | one table per object × verb on the work order (D-47 amended): EVENTS / DEAL CONTRIBUTIONS / USE CASES TO CREATE, … TO UPDATE, SPECIALIST FORECASTS TO UPDATE; legacy canvases still parse | done | merged before 9030a46 |
| engine-guidelines | `docs/ENGINES.md` (ten rules), `docs/engines/CHANGELOG.md`, `04-engines-audit.md`, B-114..B-126, CLAUDE.md read-first line | done | |
| DC1 coverage-match | [D-103](../../decisions/0103-coverage-and-event-driven-dc.md) (a): coverage rows (ae/ooo/sme, window, share), one matcher (owner/team/SFR), my AEs' deals suggested untouched | done | cd653fa |
| DC2 sfr-and-context | D-103 (b): Specialist Forecast read in `org62.discover`, other Data & AI DCs and specialists on every suggestion | done | 7a424a8 (merged 69b2954; helpers split to `attribution-sfr.ts`, e1143c6) |
| db-fixes | the ten Postgres failures the lanes could not run (canvas assertions, coverage parity, the discovery fixture) | done | before 3a68002 |
| DC3 dismissal-memory | D-103 (d): one `resurfaced()` with `lastCallAt`; the call override on all three paths; missed-opp dismissals stop being permanent (B-118) | done | e8079d3 |
| DC4 account-target | D-103 (c): `ActivityPatch.target`, zero-open-opp account settled, groundwork sentence, Org62 account search; "DCs on all N" not built (B-127); Fix reads `hasTarget()` in G4 | done | db56ca9 |
| review 3 | Fable review of F1–F7, C10, C11, DC1, DC2, WO-1 and the docs at scale 7 → `05-wave2-review.md`, R3-1..R3-15 and the fix chunks | done | 05-wave2-review.md |
| G1 one-column bodies | R3-1: LanePage keeps lane rows when the panel opens (the kit's relayout workaround, root cause B-128) | done | 6eeace7 |
| G2 lane 2 numbers and DC rows | R3-2, R3-4..R3-7: Sending above the fold, band and lane 2 counts, DC rows say their coverage once with context (UX, CHANGELOG) | done | 825c8a2 |
| G3 mixed canvas | R3-10 (+ R3-11): `legacyShape` keeps a mixed canvas's legacy rows; heading tolerance | done | da7a324 |
| G4 engine-and-docs | R3-3 forecast product lines reach the DC gate; R3-9 the DC batch wakes the lane, the ripple only for my answers; R3-14 expired windows skip the forecast read; the coverage reason's words; Fix reads `hasTarget()`; R3-12/R3-13 docs; B-127, B-128 | done | this chunk |
| VDP / Inbox / Work | the same frame on the other dense pages (own briefs after review 2) | next | |
