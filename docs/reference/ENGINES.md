# BE-3 engines core: priority, closure, re-eval (pure)

**Status:** ENGINES-core, 2026-11-05. Pure, deterministic functions with no DB, LLM or I/O. The data layer builds the inputs from rows and writes the outputs inside one `engine_pass` change set. Code is in `src/engines/{priority,closure,reeval}/`, with the input types in `src/engines/types.ts`. Tests are in `tests/engines/**`, and the §3 table is checked against this file.

## 1. Entry points

| Function | In → out | Spec |
|---|---|---|
| `rankWork(inputs)` | items, today + 3 days of meetings, policy, working hours, `now` → `RankingResult` | R-UI-2, 4, 8, 16 |
| `rerank(previousTop3, ranking, {actedOn, explicitApply})` | → `{top3, preempted, filled, rerankReady, diff}` | UI-SPEC §1.7 |
| `previewPolicy(old, new, inputs)` | → before/after Top 10 with reasons, `changedCount`, `summary`, policy diff | UI-SPEC §8 |
| `applySignal(item, signal, settings)` | → `ClosureDecision` (transition, update, proposal, sibling or none), with reason, resolution, labels and run state | DATA-MODEL §4.1, R-UI-1, 15, 20, 22 |
| `applyDecision` / `undoDecision` | Pure apply and its exact inverse. Every decision is undoable | R-UI-18 |
| `coalesce(events, debounceMs)` · `nextGeneration(item, …)` · `shouldCommit(job, item)` | Bursts → one job per item; W2 bump + cancel; W3 fence | R-UI-20, DATA-MODEL W2/W3 |
| `planReeval(changes, item)` · `pruneAfterStatus(…)` | Which of status → priority → nba → draft → brief re-run | R-UI-20, 22 |

## 2. Priority

**Deadline.** The earliest of three: the item's due date, the start of the upcoming meeting it serves (`servesEventId` or a meeting's `prepItemIds`), and any matching `sla` rule (`askedAt + slaHours`).

**`startBy`** (= `latest_start_at`) = deadline − `bufferMin` − agent minutes still to run − your minutes. It is then clamped so your hands-on part falls inside working hours; agent time may run overnight. `slack_minutes` = startBy − now. **Pre-empt** ("now late unless started") means the item is still `open`, its deadline is ahead, and startBy ≤ now + `preemptGraceMin`.

**Score.** `total = Σ weight · feature · 10 + userAdjustment + penalty-rule effects + boost/sla-rule effects`. Each feature is in [0, 1], and the components are the `priority_scores` columns.

| Component | Feature | SE IC weight |
|---|---|---|
| `deadlineProximity` | 1 if overdue, else 1/(1 + h/8). Soft due × 0.8, inferred × 0.6 | 3 |
| `calendarPressure` | 1 if slack ≤ 0, else 1/(1 + slack/90 min) | 3 |
| `leadTime` | min(1, agent/180) × (1 if the deadline is ≤ 24 h away, else 24/h). 0 once the agent has started | 2 |
| `effortFit` | you ≤5 m: 1 · ≤15: .8 · ≤30: .6 · ≤60: .35 · ≤120: .15 · else .05 | 0.5 |
| `stakeholderImportance` | max(best stakeholder tier, importance). Tiers: leader / customer exec 1, manager .9, customer .8, AE .7, partner .6, teammate .5, other .4, low .1. Importance: critical 1, high .75, normal .4, low .15 | 1.5 |
| `dealValue` | √min(1, amount / $500k) | 1 |
| `commitmentWeight` | ask 1, commitment .8, follow-up and deliverable .7, task and travel .4, training .3 | 1 |
| `staleness` | min(1, age days / 45) | 0.5 |
| `obligationBoost` | Mandatory training: overdue 1, ≤48 h .8, ≤7 d .5, else .2 | 1.5 |

**Rules** follow `priority_policy_rules`: a predicate DSL `{all/any/not, field, eq/ne/in/gte/lte/exists}` over the features. The kinds:
- `boost`/`penalty` add ±points.
- `sla` sets a deadline.
- `lane_floor`/`lane_cap` bound the lane.
- `never_above` is a hard order constraint. It also caps the lane, and it beats `lane_floor`. Likely-done items aren't protected.
- `exclude` hides the item.

The SE IC seeds are `customer_facing_over_internal` (+12), `manager_asks_within_24h` (sla 24 h, +8), `never_rank_trainings_above_customer_prep`, `external_attendee_boost` (+6) and `mandatory_trainings_today` (floor Now, due ≤ 7 d). SE manager is the other role template. Every hit is explained in the user's words, and every score carries `policyId` and `policyVersion`, plus an `inputsHash`.

**Order.** Rank by score, then by startBy, deadline and id.
- **Kick-off-first (R-UI-4):** a run of ≥ `minAgentMin` (30) that serves a deadline ≤ `horizonHours` (24) away moves up to the earliest slot where every item it jumps still starts by its own startBy. Starts are projected in rank order using your minutes only. It never jumps a pre-empt item, and it joins the lane of what it jumped.
- Then `never_above` applies.
- **Top 3** = the first `top3Size` eligible items. A training is eligible only if due ≤ `promoteWithinHours` (48), and likely-done items are never eligible.
- **Lanes** for everything else:
  - **Now:** active, or the deadline or startBy is today;
  - **Next:** due ≤ `nextDays` (3);
  - **Later:** the rest.
- **Background (R-UI-8):** a `commitment`, `open`, age ≥ `background.afterDays` (21), no deadline inside the horizon and total < `background.maxScore` (30), or `isBackground: true`. These sort oldest first, with Kick off (agent time > 0) or Renegotiate.

**Plan.** Gaps are working hours minus busy meetings (cancelled, declined, focus-time and all-day events don't count as busy), from now on.
- Top 3 and Now items are planned into the gaps first, in rank order. Items ≤ 30 m are never split.
- **Fit-ins** (trainings, plus ≤ 30 m items with score ≥ 20 and no deadline today) go into the remaining gaps ("fits your 11:30 gap").
- **Capacity** (`capacity.ts`, DESIGN-V2 "Capacity and estimates"):
  - **Free** = Σ gaps from now to the end of working hours. Only accepted meetings block time; tentative, unanswered and declined invites don't.
  - **Today's load** = hands-on minutes of today-scoped items only: pinned or planned today, a deadline today, or a start-by today for work due after tomorrow. Work due tomorrow, overdue work from earlier days and likely-done items are not load.
  - **Chores** count too: Outbox approvals batch into one "Approve N drafts" (3 min, +1 per extra), and each connector re-auth is 2 min. A chore whose item is already today's load is skipped.
  - **Agent and Claude-session time never counts.** It's reported as `agentMinBackground` and `agentRunsBackground`.
  - `openMin = freeMin − youMinToday`, and `fits = youMinToday ≤ freeMin`. "Overbooked" is only said when `fits` is false.
  - `pullForward` lists up to 5 ranked, not-today items when there's open time.
  - Legacy fields: `focusMinLeft = freeMin`, `plannedMin = youMinToday`, `overByMin = youMinToday − freeMin`.
  - **Estimates** (`estimate.ts`): `DEFAULT_HANDS_ON` by kind applies when `youMin` is 0 or missing. `calibrate()` adjusts the defaults from items where the user set the effort.

**Stability.** Previous Top 3 positions are kept. An item you acted on, or one that left the ranking, frees its slot, and the slot is filled from the new order. A pre-empt item in the new Top 3 takes its new position. Anything else only sets `rerankReady` (the positions that differ) and the `diff`, until `explicitApply`.

## 2b. priority@2 (lane 07 §4, H-8; `src/engines/priority/v2`)

priority@2 runs through the same pipeline as §2 (rules, kick-off-first, `never_above`, Top N, lanes, plan, capacity) through the `RankEngine` seam in `rank.ts`; without an engine `rankWork` is priority@1.1 exactly. `rankWorkV2(inputs)` reads the persona's priority block (`inputs.priorityConfig`, `src/personas/*` `priority`, merged over `DEFAULT_PRIORITY_CONFIG`, plus the accepted learning nudges). No persona-specific code lives in the engine.

**Need-by** = the earliest of: the due date; the upcoming meeting it serves, moved earlier by a matching **prep rule** (`readyBeforeMin`; a customer demo/POC/workshop/architecture prep is ready 30 min before and at least `high`; an exec readout 60 min and `critical`) or by an **onsite day** (prep for a meeting on a day held by a ≥ 6 h busy block, or a working location named onsite, is ready by the end of the last working day before); the policy's `sla` rules; and, for an ask with no date, the **owed-reply SLA** by the asker's tier in working hours (SE: customer exec 4, leader and customer 8, manager, AE, partner 24, teammate 48). A focus block, OOO or working-location event is never a deadline: a linked focus block is a start-by hint (the work starts by the block). An item whose work is attending the meeting it serves ("Take the Oakhallow call if Theo is out") needs no hands-on minutes before it (`attendPattern`). An item with no estimate takes its extractor size class (XS 10, S 30, M 90, L 180, XL 360).

**Start-by, planned backwards** (`startby.ts`): free time = the persona's working windows over 10 working days minus busy meetings. Items are placed in need-by order (earliest first), each as late as it fits before its own need-by − `bufferMin` in what the earlier ones left, so a later deadline plans around the nearer ones ("minus already-committed work"): a Friday deliverable with a Thursday onsite starts Wednesday. Work ≤ 30 min is never split across gaps; pieces under 15 min are skipped. A shortfall within max(10 min, 15 % of the effort) keeps the plan's start; beyond it the work starts now (`fits: false`). An agent run is wall-clock time: it only bounds the kick-off (need-by − buffer − agent − you); it never takes your hours. `reservePct` (default 0) keeps a share of free time for interrupts. Monotone: a meeting added inside the window never moves a start-by later (property test).

**Score.** `P = V × (floor + U) + rule effects + userAdjustment`, `floor` 0.25.
- **V** (0–100) `= Σ weight · term`, SE weights who 30, deal 25, kind 20, importance 15, goal 10 (Specialist AE: who 25, deal 35, kind 15, importance 15, goal 10):
  - *who*: the best stakeholder's tier (leader / customer exec 1, manager .9, customer .8, AE .7, partner .6, teammate .5, other .3, low .1); a manager who asked counts as at least .9; nobody named on a customer account counts as that customer (.8).
  - *deal*: a monotone band table (SE: none 0, < $100k .3, < $500k .5, < $1M .7, < $3M .9, ≥ $3M 1; AE bands at $50k / $250k / $750k / $2M).
  - *kind*: a promise or customer prep 1, an ask .9, customer work .8 (the SE counts work on a customer opp as customer work; the AE also counts partners as customer-facing), a follow-up .7, an internal task .4, admin .3.
  - *importance*: the extractor's (critical 1, high .75, normal .4, low .15), raised by a prep rule.
  - *goal*: pay-linked admin (SE: logging, deal contributions; AE: forecast notes, logging) whose deadline is at risk: .8.
- **U** (0–1) from the planned start-by: start-by passed 1; later today .8 rising to 1 as the free minutes before it fall below 240; next working day .5; within 3 working days .3; later .1; no need-by .05. Work that must start today only because the hours before a later-day need-by are committed caps at .85. A late hard deadline is 1 for one working day, then .6; a late soft or inferred one .4 (`why.ts lateState`). Soft deadlines ahead × .9, inferred × .8; waiting on them × .3 (and a chase is planned at the expected reply time). Property tests: a bigger deal never lowers V or P; a nearer deadline never lowers U or P.
- **Rule effects**: the policy's boosts, penalties and SLA effects, except the role-template rules the terms already carry (`supersededRuleEffects`: customer-facing, external prep, the manager's 24 h ask; their deadlines still count). Rules the user adds always apply.

**Order.** As §2, with: kick-off-first moves only work with V ≥ 50; a late item that only needs re-dating and the **admin batch** sort after every lane (re-date rows first); admin is never in the Top N.

**Admin batch** (`admin.ts`): logging, VDP, deal contributions, use cases, expenses, trainings and sweep reminders (persona title patterns and kinds) become one row ("Admin: 4 items · ~25m · next due Fri 16:00"). It is today's load only when an item is due within 48 h, late, or must start today; then it is placed in the day's lowest-value free slot (the gap the backward plan values least).

**Capacity.** The p0 rule (due today, start-by today, pinned, plus the promoted admin block) against the calendar's free minutes. Overbooked reads "Overbooked by N min" everywhere; `makeRoom` lists what to move: lowest V first, latest deadline first among equals, never a pinned item or a hard deadline later today, until the overflow is covered.

**Why** keeps p0's two parts: *matters* = the top two value terms (`value.who`, `value.deal`, …), *now* = the need-by, start-by and free time before it.

**Shadow and feedback.** `settings.priority.engine` = `v1` | `shadow` (default) | `v2`. In shadow each re-rank records both orders on its `priority_runs` row (`ranking`, `shadow_ranking`, `agreement3`); v2 writes `priority@2` scores with `value`, `urgency`, `terms`. `priority_feedback` keeps every reorder, snooze, "not today", pin and "do first" with the terms at the time; the nightly `priority.feedback` pass turns a term that keeps disagreeing into one `priority_rules` suggestion (a ±10 % nudge of one weight, bounded to 0.5–1.5 × the preset; urgency raises the floor). The auto re-rank (`priority.rerank`) runs 60 s after inputs change and keeps the shown Top 3 (§ Stability).

**Golden days** (`tests/evals/priority`): the sample Wednesday, the Friday blueprint, the onsite Monday and an overbooked Tuesday; priority@2 passes every expectation and the test prints agreement@3 for both engines.

## 2c. Needs you (01 R1, D-86; `src/engines/needs`)

The one queue behind `GET /needs`. Pure: the server gathers a `NeedsContext` from the existing DataSource reads (`src/server/datasource/db/needs.ts`, run by both DataSources: triage, outbox, activity log of the last 14 weeks, DC suggestions, health's spend asks and setup, VDP coverage, the guide, open work items, use-case candidates, queue snoozes), each read allowed to fail on its own.

| Function | In → out |
|---|---|
| `NEED_PROVIDERS` | one provider per `NeedKind` (`providers/*.ts`), each `run(ctx) → NeedRow[]`; a provider may name the persona feature its kind needs |
| `composeNeeds(ctx, providers?, {onError})` | → `NeedsPayload`: providers whose feature is inactive skipped; a throw → zero rows, `partial`, one `onError` (the server logs `BUG.NEEDS_PROVIDER`); verbs gated by feature, rows without their primary verb dropped; dedupe by id and by `subject` (`item:<id>`, `opp:<id>`: the more urgent row keeps the other's verbs and lists its kind in `also`); order urgency ↓, since ↑, id; no cap |
| `planNeedDecision(row, {verb, choiceId?, reason?, until?})` | → the existing route (`NeedDispatchRoute`) and its payload, or a validation error (no such verb, a navigation verb, a choice not offered) |
| `needsCount(payload)` | the one count: `total` (the sidebar, Home, Activity) |
| `workItemUrgency(item, ctx)` | priority@2's `urgencyOf` over the item's due, start-by, deadline kind and waiting; `KIND_URGENCY` for every other fact (spend ask .9, setup .7, draft .6, reopened .6, guess .5, question .4, time .4, Looks done .3, DC .3, VDP .3, use case .3) |

Each verb carries the route and payload its page already sends (`acceptTriage`, `dismissTriage`, `itemAction`, `markItemSeen`, `rejectDraft`, `decideDcSuggestion`, `decideUseCaseCandidate`, `answerSpendHold`, `decideNeed` for Later), or an `href` (Review in the Outbox, Activity ▸ VDP, Health ▸ Setup). Nothing dispatchable sends: `POST /needs/:id/decide` lists the queue again, plans the verb and calls that DataSource method with its parsed input, returning its `auditId` for Undo. The edge cases are NQ-01..07 in `docs/EDGE-CASES.md`.

## 3. Closure transition table

Codes:
- `·`: evidence attached, nothing else;
- `ctx`: recorded as context only;
- `upd`: fields only;
- `prop`: a `change_proposals` group (user-locked);
- `sib`: a new sibling under the same initiative or parent (`reopen_decisions.new_sibling`);
- `reopen`: done/dismissed → open (`reopened`);
- `wake`: snoozed → its previous state;
- `ip`/`woo`/`wom`/`ld`/`open`/`done`: the target state.

State columns:
- `≤N` / `>N`: closed within / outside `reopen.window_days`;
- `h/o`: handed off (involvement watcher or not involved);
- `open, locked`: `status` is in `user_locked_fields`.

Signal rows:
- `done_*`: completion evidence at Sure / Likely / Guess;
- `drive_*`: a Drive digest with an edit only / partial / "updates made";
- `reply_me`: my reply after the ask;
- `reply_them`: the counterparty replied;
- `email_sent`: Sure, with the file attached.

The base item is an `ask` using `reply_in_thread`.

| signal ↓ · state → | sug | open | open, locked | ip | woo | wom | ld | done ≤N | done >N | h/o ≤N | h/o >N | snz | dis | mrg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `origin` | · | · | · | · | · | · | · | · | · | ctx | ctx | · | · | · |
| `progress` | · | ip | prop | · | · | · | · | · | · | ctx | ctx | · | · | · |
| `done_sure` | · | done | prop | done | done | done | done | · | · | ctx | ctx | · | · | · |
| `done_likely` | · | ld | prop | ld | ld | ld | · | · | · | ctx | ctx | · | · | · |
| `done_guess` | · | · | · | · | · | · | · | · | · | ctx | ctx | · | · | · |
| `context` | · | · | · | · | · | · | · | · | · | ctx | ctx | · | · | · |
| `contradiction` | · | · | · | · | · | · | ip | reopen | sib | ctx | ctx | · | · | · |
| `requirement` | · | · | · | · | · | · | ip | reopen | sib | ctx | ctx | · | · | · |
| `loop_back` | · | · | · | · | · | · | · | reopen | sib | reopen | sib | wake | reopen | · |
| `session_waiting` | · | wom | prop | wom | wom | upd | wom | · | · | ctx | ctx | · | · | · |
| `session_running` | · | ip | prop | · | · | ip | · | · | · | ctx | ctx | · | · | · |
| `session_done` | · | ld | prop | ld | ld | ld | · | · | · | ctx | ctx | · | · | · |
| `session_failed` | · | · | · | · | · | ip | · | · | · | ctx | ctx | · | · | · |
| `drive_edit` | · | ip | prop | · | · | · | · | · | · | ctx | ctx | · | · | · |
| `drive_partial` | · | ip | prop | · | · | · | ip | · | · | ctx | ctx | · | · | · |
| `drive_yes` | · | ld | prop | ld | ld | ld | · | · | · | ctx | ctx | · | · | · |
| `reply_me` | · | done | prop | done | done | done | done | · | · | ctx | ctx | · | · | · |
| `reply_them` | · | · | · | · | open | · | · | · | · | ctx | ctx | · | · | · |
| `email_sent` | · | done | prop | done | done | done | done | · | · | ctx | ctx | · | · | · |
| `timer` | · | · | · | · | open | · | · | · | · | · | · | wake | · | · |

**Rules behind the table:**
- **Sure completion → `done`.** It runs at L4 internal (`autonomy: 'L4_auto'`) and records the evidence id and an inferred resolution: done by me, done by X, or "handed off → X", which sets my involvement to `handoff.my_involvement`. **Likely → `likely_done`** ("Likely done · Confirm"), remembering `likelyDoneFromStatus` and the proposed resolution. Guess attaches only.
- **`session_done`** is a likely-done check, unless the item's closure test is `claude_session_completed`, which makes it Sure. App runs go to `done_review`; sessions Tristan started himself go to `done`. Waiting maps to `waiting_on_you`, and failed to `failed`.
- **Drive alone never closes.** A `drive_yes` by someone else proposes `done_by_other`.
- **Reopen vs sibling.** A done item gets a new requirement or a contradiction. If it's the same deliverable (the scanner's `sameDeliverable` wins; otherwise `deliverableRef` ∈ `deliverableRefs`/`closureTarget`) **and** it closed ≤ N days ago, it reopens: "Reopened: new requirement from Sam · Undo". Otherwise a sibling opens: "New task: … (original closed 20d ago)" or "(different deliverable)". The rule keys are `same_deliverable_recent`, `outside_window` and `different_deliverable`, plus `loop_back_recent` and `loop_back_outside_window`.
- **Loop-back.** A scanner origin with the reason prefix `loop_back:` is a direct ask of me. It reopens the item or opens a sibling ("Looped back in: Dana asked you directly · Undo"), sets involvement to owner, wakes a snoozed item, and is the only way out of `dismissed`. Duplicate, superseded and merged items route new evidence to the survivor (`redirectTo`).
- **Locks.** A transition when `status` (or W0's `state`) is locked, or when a field the target state needs is locked (`done` needs `doneAt`/`doneBy`; `waiting_on_me` needs `waitingReason`), becomes one proposal group with `baseVersion`. Other locked side fields are proposed while the rest applies. A sibling is still allowed, because it doesn't touch the locked item.

**Settings** (`user_settings`, with defaults):

| Key | Default | Notes |
|---|---|---|
| `reopen.window_days` | **14** | **DATA-MODEL OQ-7 says 7.** This brief sets 14 |
| `close.auto_sure` | true | Plus the per-item `auto_close_allowed` (undefined = allowed) |
| `snooze.wake_on_new_info` | false | When true, any new evidence also wakes the item (DATA-MODEL W2 variant) |
| `handoff.my_involvement` | watcher | My involvement after a hand-off |

## 4. Re-eval

- **`coalesce`.** Events for an item that fall within `debounceMs` of the previous one, and within `maxWaitMs` (10 × debounce) of the first, merge into one job: `dedupeKey reeval:work_item:<id>`, `runAt` = last event + debounce (capped), `generation` = the max, and the changes and evidence ids merged.
- **`nextGeneration`.** Bumps `reeval_generation`. Evidence-type changes also set `last_new_info_at` and increment `unseen_evidence_count`. It requests cancel of the running job, supersedes it, and coalesces into the queued job (pushing `runAt` out) or inserts a new one.
- **`shouldCommit`.** Returns `cancel_requested` or `stale_generation` (drop), `future_generation` (a bug; drop), `version_conflict` (re-read and re-run, `retry: true`), or `ok`.

**Planner:**
- Status-moving changes on an owned live item re-run status, priority, NBA and the draft.
- Context re-runs the NBA, draft and brief.
- Calendar and entity changes re-run priority, NBA and the draft.
- A policy change or schedule edit re-runs priority.
- A content edit re-runs the NBA and draft.
- `draft_edited` re-runs nothing.
- On handed-off or not-involved items, only the **brief** re-runs, unless there's a `loop_back`.
- Suggested items re-check status.
- Closed and snoozed items re-check status and priority, and `pruneAfterStatus` adds the NBA and draft if the item comes back.
- A user-locked draft gets `mode: 'propose'`.

## 5. Names to reconcile with W0's contract

| Engine (DATA-MODEL) | W0 contract | Note |
|---|---|---|
| `WorkItemStatus`, including `merged`, without `reopened` | `WorkState` has `reopened` and no `merged` | Reopened is a label on `open` (UI-SPEC §11) |
| `WorkItemKind` (scanner set: `follow_up`, `deliverable`) | `WorkKind`, same | DATA-MODEL enum: `missed_meeting_followup`, `background_promise`, no `deliverable` |
| `PolicyWeights` = `priority_policies.weight_*` | `PolicyWeightKey` (`customer_facing`, `meeting_proximity`, `due_urgency`, `manager_ask`, `age`…) | Map `due_urgency`→`deadlineProximity`, `meeting_proximity`→`calendarPressure`, `age`→`staleness`. `customer_facing` and `manager_ask` are rules here |
| `PolicyRule` (rule DSL) | `PolicyRule {when, boost}` | W0's form maps to `boost` rules |
| `ScoredItem.reasons: RankReason[]`, `startBy`, `effort` | `WorkItemRecord.rankReasons`, `startBy`, `effort` | Same shape |
| `SpineSlot` (+`mode`), `FitInEntry`/`BackgroundEntry` (`hint`, `action.verb`), `Capacity` (+`agentMinQueued`), `rerankReady` | `SpineSlot`, `ShelfEntry`, `TodayHeader.capacity`, `nowStack.rerankReady` | Supersets |
| `ClosureItem.resolution`, `involvement`, `resolutionDetail`, `loopedBackIn`, `likelyDoneFromStatus`, `nudgeAt`, `dismissedAt`, `deliverableRefs` | Present in `WorkItemRecord` (except the last four) | **Not yet columns in DATA-MODEL `work_items`** |
| `PolicyTuning` (thresholds versioned with the policy) | — | Needs a `priority_policies.tuning` jsonb column, or `user_settings` keys |
