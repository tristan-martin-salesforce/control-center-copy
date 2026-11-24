# 07 · Prioritization review (what Home decides, and whether it is right)

Reviewer lane: PRIO. Scope: the priority engine, Home's cut, NBA, re-rank, personas' role context, learning, legibility. How Home *looks* is UI-AUDIT's lane; product comparisons are UI-RESEARCH's.

Method: I read the code listed in the brief and ran the real engine (`rankWork`, `src/engines/priority`) over `sample-data/tables` at the sample "now" (Wed 2026-11-18 09:00 MST). The script maps rows the way `src/server/datasource/db/rank.ts:192-243` does, and is in the scratchpad (`/private/tmp/claude-501/-Users-tristan-orca-workspaces-control-center-copy-kraken/dd7f7aa7-ba88-4d0f-aa26-46404f79573e/scratchpad/rank-sample.ts`). I then emulated Home's Do-now cut (`build.ts:1339-1352`). I did not run Postgres, so the db read path is reproduced, not executed.

## 1. Summary

1. **The engine is more advanced than ARCHITECTURE §5 says, but it ranks the sample day wrong.** It has deadlines, start-by, lead time, capacity, kick-off-first sequencing and explainable rules. Even so, its Top 3 for the sample SE is three *overdue* chores (a value recap 2 days late, a missed check-in follow-up from 11/09, notes for a 10:00 sync). Tomorrow's $780k demo build ranks #12 and the $1.25M Friday blueprint #18. The cause is that any overdue item takes the maximum of both urgency terms (60 of about 140 points) forever (PRIO-1).
2. **"When do I need to start the build" is only half there.** Start-by is wall clock minus effort, clamped to working hours. It ignores the meetings between now and the deadline, looks 4 days ahead, and assumes an agent does the build (30 hands-on minutes by default). Capacity treats work due tomorrow as tomorrow's load, so it says "fits, 35 min open" while the 150-minute demo build due tomorrow at 09:30 is left out (PRIO-2, PRIO-3).
3. **Two pages give two different answers.** Today shows the engine's Top 3. Home shows "due/start-by today, by stored rank", with the whole Outbox fixed at #2. Ranks only change when the user applies a re-rank, so new items stay unranked and stored start-by dates go stale (PRIO-4, PRIO-5, PRIO-7).
4. **Role context is mostly lost before it reaches the scorer.** The extractor's importance, the due-date kind (hard, soft, inferred), when the ask was made and people's tiers (leader, customer exec) are dropped in the db mapping. A re-rank then overwrites importance with a function of rank. Deal value tops out at $500k. "From manager" means "the manager is anywhere on the item". The pay-linked DC and logging duties never reach the score (PRIO-6, PRIO-9, PRIO-10).
5. **There is no "owed reply" model and no learning loop.** `waiting_on_me` means "a Claude session is waiting", not "a person is waiting on me". Dismissals, snoozes and ignored cards never feed the ranking. NBA generation (11 skills) is not wired in db mode, so card "why" lines come from the extractor, not from the ranking (PRIO-8, PRIO-11, PRIO-14).

## 2. How it works today

### 2.1 Pipeline (pure, deterministic, no LLM)
`rankWork(inputs)` (`src/engines/priority/rank.ts:213-406`):
1. Keep the rankable statuses: open, in_progress, waiting_on_me, likely_done (`rank.ts:28`).
2. `prepare()` each item (`score.ts:207-382`). The **deadline** is the earliest of: the due date, the start of the meeting it serves (`servesEventId`, or a meeting's `prepItemIds`), and any SLA rule (`askedAt + slaHours`) (`score.ts:162-196`). **startBy** = deadline − buffer (15) − agent minutes still to run − your minutes, clamped so your minutes fall inside a working window (`score.ts:222-226`, `time.ts:119-130`). **Pre-empt** means the item is open, its deadline is ahead and start-by is within 5 minutes (`score.ts:228-233`).
3. Score = Σ weight · feature · 10 + userAdjustment + rule effects (`score.ts:286-350`). It is additive, not ARCHITECTURE §5's "urgency × importance × commitment + goal boost − effort" (`docs/ARCHITECTURE.md:129`).

| Component | Feature (score.ts) | SE IC weight (policy.ts:216-226) | Max pts |
|---|---|---|---|
| deadlineProximity | overdue → 1, else 1/(1+h/8); soft ×0.8, inferred ×0.6 (`:236,245`) | 3 | 30 |
| calendarPressure | slack ≤ 0 → 1, else 1/(1+slack/90) (`:248`) | 3 | 30 |
| leadTime | min(1, agent/180) × (≤24 h ? 1 : 24/h) (`:257-260`) | 2 | 20 |
| effortFit | ≤5 m 1 … >120 m .05 (`:204-205`) | 0.5 | 5 |
| stakeholderImportance | max(tier of best stakeholder, importance) (`:263-269`) | 1.5 | 15 |
| dealValue | √min(1, amount/$500k) (`:272`) | 1 | 10 |
| commitmentWeight | ask 1, commitment .8, follow-up .7 … training .3 (`:41-49`) | 1 | 10 |
| staleness | min(1, age/45 d) (`:276`) | 0.5 | 5 |
| obligationBoost | mandatory training only (`:280-284`) | 1.5 | 15 |
| rules | customer-facing +12, external-meeting prep +6, manager SLA 24 h (+8), trainings never above customer prep, mandatory trainings floor Now (`policy.ts:229-283`) | | |

4. Old, low-scoring commitments go to the background (`rank.ts:48-56`). The rest is sorted by score, then start-by, then deadline (`rank.ts:39-46`).
5. Kick-off-first: an agent run of ≥ 30 min serving a deadline ≤ 24 h away jumps ahead if everything it jumps still meets its own start-by (`rank.ts:80-117`). Then `never_above` applies (`rank.ts:123-147`).
6. **Top 3** = the first 3 eligible items (trainings only when due ≤ 48 h, never likely-done) (`rank.ts:184-192,251-253`). **Lanes:** Now (active, or the deadline or start-by is today), Next (due ≤ 3 d), Later (`rank.ts:194-207`).
7. Day plan and capacity (`plan.ts`, `capacity.ts`). Free time = working hours minus accepted meetings. Today's load = items pinned, due today, or with a start-by today *for work due after tomorrow* (`capacity.ts:45-51`), plus chores ("Approve N drafts" at 3 min + 1 per extra). Agent minutes never count. `fits = load ≤ free`. Pull-forward offers up to 5 ranked items. **Top 3 never consults capacity.**
8. Stability: `rerank(previousTop3, fresh)` keeps positions unless the user acted, an item pre-empted, or the user pressed Apply. Otherwise it only counts "Re-rank ready · n" (`stability.ts:38-60`).

**Where "why" comes from.** Each component carries a reason string. `reasonsOf()` sorts them by points, and the top 3 labels join into `explanation` (`score.ts:398-406`, `rank.ts:278-293`). That text is stored on `priority_scores.explanation` and as `rankReasons`, and the NBA card shows it (`components/domain/NbaCard.tsx:763`). The **Home card's why is `n?.why ?? w.why`** (`build.ts:688`): the NBA's or the extractor's sentence, not the ranking's.

### 2.2 What feeds it (db mode)
`priorityInputs()` (`db/rank.ts:246-268`) and `priorityItem()` (`db/rank.ts:192-223`) supply kind, status, due, effort (`effort_minutes`; agent = `lead_time_minutes − effort`, `store/work.ts:268-269`), stakeholders (tier inferred from `role` text, `db/rank.ts:182-190`), opp amount, served meeting, createdAt, the customer-facing, from-manager and boost signals, and training facts. Meetings run from now − 1 d to now + 5 d (`db/rank.ts:249-261`). The policy comes from the persona level's template (`personas/se.ts:17-19`, `ROLE_POLICIES` `policy.ts:356`).

### 2.3 When it re-ranks
- `rerankToday` (the user presses r or Apply), a policy or chat change, `db:seed`, and **once** after a first scan (`worker/first-scan-rerank.ts:1-38`: "Nothing ranks work after a scan").
- The re-eval planner lists a "priority" step (`reeval/planner.ts:54-61`), but the closure pass only enqueues `nba.generate` follow-ups (`db/closure.ts:676-684`).
- D-73 keeps ranked lists on explicit apply (`DECISIONS.md:89`).
- A re-rank writes `priority_runs`, a `priority_scores` row per changed item and plan steps. It refreshes the rank cache and **rewrites `startBy` and `priority`** on the item (`db/index.ts:710-760`).

### 2.4 NBA
`src/engines/nba/prompt/*` and `skills/nba-*.md` define one LLM call per item that picks a verb and returns title, why, effort, startBy, draft or plan (`skills/nba-common.md`). The model tier depends on the verb (`verbs.ts:134`). **In db mode it is not wired:** `nba.generate` is registered `wired: false` (`src/jobs/index.ts:54`) and defaults to `notWired` (`jobs/handlers/nba.ts:18`). The only `registry.wire` is `reevaluate` (`worker/index.ts:152`), and `insertNba` is called only by the seed (`db/seed.ts:259`). NBA plays no part in ranking. On Home it only changes the card verb and title when one exists.

### 2.5 Personas
Duties and rules are plain English (`personas/se.ts:26-43`) and are rendered only into LLM prompts (`personas/prompt.ts:9-31`). The persona influences ranking only by picking the role template (`server/persona/switch.ts:20`) and by switching Log & fix rules on and off (`build.ts:321-344`).

### 2.6 Home's sections (`buildHome`, `build.ts:1328-1467`)
In order, and "nothing listed twice":
1. **Log & fix** (`gapRules`, `:346-588`). Connector auth, quarter log vs target, unlogged Org62 events, DC and use cases waiting for a canvas, DC gaps (D-61), needs-input rows, expenses, and the persona's own gaps. Rows claim items **by title regex** (`/log/i`, `/request (a )?dc/i`: `:388,478,505`).
2. **Do now** (3 cards). Today-scoped items (due, start-by or pinned today; `:225-226`), sorted by **stored** `rank` (`:243`). **The Outbox "Approve N drafts" card is spliced in at #2** (`:1344`), with connector re-auths after. It is topped up with the next ranked items when fewer than 3 (`:1355-1363`).
3. **Reply & approve.** "Replyish" items (ask, reply verb, has a draft, or the title starts with "Reply…"), sorted by **due date** (`:739-790`).
4. **Chase.** Items waiting on others (oldest first) plus undated commitments of 5 days or more ("promises"), folded by initiative (`:910-1006`).
5. **Think ahead** (14 days). Linked meetings, dated work, deals closing; overdue first, then at-risk (`:800-907`).
6. **Initiatives**, the ribbon (from the same capacity), "Looks done", "Closed for you", and the footer.

### 2.7 Worked example: Wed 2026-11-18 09:00 MST, SE IC policy, sample data
The engine's own output (real code, sample rows):

| # | Item | Score | Top reasons (engine `explanation`) |
|---|---|---|---|
| T1 | Send Anjali a one-page value recap (overdue since Mon) | 120.7 | late unless started now (start by Mon 14:15) · overdue since Mon 17:00 · agent needs ~2h |
| T2 | Follow up on the Halvergate check-in I missed on 11/09 (overdue since Thu 11/12) | 110.9 | late unless started now (start by Thu 15:45) · overdue · customer-facing rule |
| T3 | Bring Q4 pursuit coverage notes to the SE team sync (10:00) | 98.2 | late unless started now · by Sun 12:21 (your 24h rule) · Hana (your manager) |
| 7 | Take the Oakhallow order form call if Theo is out (14:30) | 91.5 | call in 5h30m · Hana (your manager) · customer-facing |
| 8 | Technical sign-off on the Oakhallow addendum (reopened; call 14:30) | 90.9 | call in 5h30m · Valentina (customer exec) |
| 9 | Reply to Nadia about the Elderglen demo | 84.1 | due 17:00 · customer-facing |
| 12 | **Build the Elderglen order-status demo** ($780k, demo Thu 10:00, 150 min hands-on) | 69.1 | customer-facing · Brendan (customer) · opp $780k |
| 18 | **Solution blueprint for the Saltmere POC** ($1.25M, Fri 17:00, 240 min) | 56.5 | Priyanka (customer exec) · customer-facing · opp $1250k |

Components: the overdue recap gets deadline 30 + pressure 30 + lead 13.3. The demo build gets deadline 7.4 + pressure 6 + lead 6.5. Both get the same customer +12 and deal 10, because $780k and $1.25M both saturate the deal term. Capacity: load 295 min against 330 free, so "fits", 35 min open. The demo build is *not* load (due tomorrow). Agent background is 540 min. Chores: "Approve 13 drafts" for 15 min (Home's card counts 11 message drafts; the 4 VDP drafts and 1 canvas draft are admin).

**Home's first screen** (emulated cut): Do now = (1) Bring Q4 coverage notes, (2) **Approve 11 drafts**, (3) Finish blueprint sections 6–7. The Oakhallow sign-off, Nadia's reply, the OMS sandbox and the demo build fall to "#4 is in Reply & approve…". **Today's Top 3** shows the Anjali, Halvergate and Q4 items. The overdue items aren't today-scoped on Home, so they appear in Think ahead as Overdue.

**Is it the right list?** No. By the CAST storylines (CAST-work.md, "Anchors"), a good SE first screen for that morning is:
1. **Oakhallow technical sign-off** before the 14:30 call. It was reopened at 08:5x by Valentina's late reply, and Valentina is a customer exec. Her drafted reply is in the Outbox batch.
2. **Elderglen demo: reply to Nadia, then build plus the OMS sandbox wiring.** The demo is tomorrow at 10:00 and needs about 3.5 h hands-on. Thursday morning has no room, so it has to be today.
3. **Blueprint sections 6–7 in the 09:30–12:00 focus block.** Friday's $1.25M deliverable, and Thursday afternoon is full.

Then a "quick before 10:00" row (Q4 notes), a Respond batch (Hana, Folasade, Soo-jin, Marisol), and the gone-quiet Anjali recap as a Chase or "re-date" row, not #1. The sample's generator-authored `priority_scores` (Top 3 = wi-060, wi-031, wi-003) agree with this human reading and disagree with the real engine. That gives a ready-made golden expectation.

Caveat: sample `lead_time_minutes` makes many emails carry 30–120 agent minutes. Prod derives agent minutes the same way (`store/work.ts:269`), so the "agent needs ~2h" artifacts are realistic whenever the extractor fills lead time loosely.

## 3. Findings

**PRIO-1 · blocker · Overdue saturates the score.**
- What happens: `deadlineF = 1` and `pressureF = 1` for every overdue item, however long ago and whatever its due kind (`score.ts:245,248`). That is 60 of about 140 weighted points, permanently.
- Evidence: in §2.7, 2- and 6-day-overdue follow-ups outrank tomorrow's demo build. Overdue items also get pre-empt-style "late unless started now (start by Mon 14:15)" text.
- Why it matters: this is exactly "one more channel of noise". The list fills with things already late instead of things about to be late. *Tenet: Calm, not a firehose.*

**PRIO-2 · blocker (goal a) · Lead time ignores the calendar and SE build effort.**
- What happens: start-by = deadline − effort, clamped only to working windows. Meetings between now and the deadline are ignored (`time.ts:119-130`). The horizon is 4 days (`policy.ts:208`), and meetings are read only 5 days out (`db/rank.ts:250`).
- Effort: the default "build" is 10 min kickoff + 20 min review, because the agent is assumed to do the build (`estimate.ts` `DEFAULT_HANDS_ON`, `skills/nba-common.md` "A build is kickoff plus review"). For an SE a demo build, blueprint or POC is hours of hands-on work.
- Prep: prep tasks exist only when someone explicitly asks for prep (`skills/scan-calendar.md:81`). A customer demo on Thursday does not create "start the build by Tuesday".
- In §2.7 the blueprint's start-by is Thu 13:30, but Thursday 14:00–16:45 is meetings and training.

**PRIO-3 · major · Capacity undercounts "must start today" work, and the Top N ignores capacity.**
- What happens: work due tomorrow is never today's load (`capacity.ts:45-51`), and a test pins this down: "an item due tomorrow is never in youMinToday, however big or urgent it is" (`tests/engines/priority/properties.test.ts:283`).
- Inconsistency: Home's today scope *does* include any start-by today (`build.ts:225-226`), so the ribbon's "fits" and the Do-now cards disagree.
- Top 3 is the first 3 eligible items, never fitted to free time (`rank.ts:253`).
- Why it matters: "fits, 35 min open" is false reassurance on the day the demo has to be built.

**PRIO-4 · major · Home and Today decide differently.**
- What happens: Today shows the engine's stable Top 3 (`db/rank.ts:303-321`). Home shows stored-rank today items with the Outbox at #2 (`build.ts:1339-1352`).
- Sample: Today = Anjali, Halvergate, Q4. Home = Q4, Approve 11, blueprint 6–7.
- Why it matters: *Legible* and *Trustworthy* both fail if "the next 3 things" depends on which page you open.

**PRIO-5 · major · Ranks and start-by go stale between explicit applies.**
- What happens: no re-rank after scans except the first (`first-scan-rerank.ts:4-11`). The re-eval "priority" step is a no-op in the closure pass (`db/closure.ts:676-684`).
- New items have `rank = null` and sort after every ranked item (`db/rank.ts:91-98`, `build.ts:243`). Stored `startBy` changes only on a re-rank (`db/index.ts:741-751`).
- Why it matters: an urgent ask that arrived at 08:30 sits below yesterday's ranking until the user presses r. The re-rank pill becomes a chore (goal b).

**PRIO-6 · major · Judgment inputs are dropped, then overwritten.**
- Dropped: `priorityItem()` passes no `importance`, `dueKind` or `askedAt` (`db/rank.ts:200-222`). The DB has `importance` (17 high and 4 critical in the sample) and `due_kind` (30 inferred, 23 soft).
- Tier: `people.tier` (leader, customer_exec) is never read into `Person` (`store/entities.ts:68-79`). Tier is guessed from a `role` text regex (`db/rank.ts:182-190`).
- Overwritten: a re-rank sets `priority = priorityFor(rank)` (`db/index.ts:739`), which is persisted to `importance` (`store/work.ts:403`, `enums.ts:134`). The extractor's judgment is erased and the importance column becomes circular.
- Dead rule: the sample's active policy rule `r_noise_exclude` (importance = low) can never fire.

**PRIO-7 · major · Drafts as a list.**
- What happens: every ready message draft becomes one Outbox card fixed at Do-now #2, showing the 3 most recent drafts (`build.ts:201-203,706-731,1344`). That holds whatever the drafts belong to.
- Sample: the 11 drafts include one for a *suggested* item (Tobias) and one for a *waiting-on-others* item (Theo DM), mixed with the Valentina reply that unblocks the #1 customer item. The draft's priority is its item's priority, but the card throws that away.
- Reply & approve sorts by due date, not by rank (`build.ts:754-758`). This is the owner's named complaint, and its root is a decision, not styling.

**PRIO-8 · major · "People I owe a reply" is not modeled.**
- What happens: `waiting_on_me` is set for Claude sessions waiting for input (`closure/machine.ts:443-449`).
- An ask with no due date gets no deadline. Its only urgency is staleness at weight 0.5, maxing at 45 days (`score.ts:276`).
- There are no last-inbound or last-outbound timestamps, and no reply SLA by tier except the manager's 24 h.
- Waiting *on them* is modeled well: Chase, `waiting.since`, nudge timers (`machine.ts:378`, `build.ts:910-940`).

**PRIO-9 · major · The manager SLA misfires.**
- What happens: `from_manager` is true when *any* stakeholder is the manager (`score.ts:130`), and the SLA counts 24 h from `createdAt` (`score.ts:182-188`, because `askedAt` is not passed).
- Sample: the mandatory training and "cover the Oakhallow call" get "by Tue 06:55 (your 24h rule) · Hana (your manager)".
- Why it matters: "a leader's ask outranks" needs the *asker*, not attendance.

**PRIO-10 · major · Role context is missing from the score.**
- Pay-linked work: there is no goal boost for DCs or logging (ARCHITECTURE §5 promised one). They exist only as Log & fix rows without urgency, plus a "risk" state 3 days before the quarter deadline (`build.ts:400-404`).
- Deal size: deal value saturates at $500k (`score.ts:272`), so a $2M deal's prep weighs the same as a $500k one. Stage, close date, forecast category and quarter-end are not features (`policy.ts:13-38`).
- Duties: persona duties never reach the policy (`personas/prompt.ts`).

**PRIO-11 · major · NBA is not wired, and the card "why" is not the ranking's why.**
- Evidence: §2.4. Home's card why = NBA why or the extractor why (`build.ts:688`).
- Why it matters: with no NBA live, the line under a ranked card is the extractor's description, not why it is #1. *Tenet: Legible.* Eleven skills and about 2.5k lines of NBA prompt code are dormant. That is fine for ranking (the ranking should not depend on them), but the docs and UX assume them.

**PRIO-12 · major · Admin leaks into the main list.**
- What happens: system-rule items ("Add the deck to the … VDP", "Monthly VDP review", "Review last week's missed DC findings", "Log this week's time") are ranked like customer work (#32–#40 in the sample). They surface in Think ahead (`build.ts:858-870`) and as fit-ins (the sample's 3rd fit-in is a VDP deck add).
- Gap rules find their items by title regex, so a renamed item escapes its Log & fix row (`build.ts:388,478,505`).
- Why it matters: this mixes admin into "what's important" (goal b).

**PRIO-13 · minor · Some "why" text is untrue or uninformative.**
- Overdue items say "late unless started now (start by Mon 14:15)".
- Emails say "agent needs ~2h: kick off early".
- "Ranked up: your rule 'customer-facing beats internal'" appears on nearly every SE item, so it never separates them.
- Likely-done items still rank #4–#5 with over 110 points (excluded from Top 3 and from Home, but they pollute lanes and pull-forward).

**PRIO-14 · major · No learning from behaviour.**
- What exists: effort calibration from items whose effort the user set (`db/capacity.ts:10-11`, `estimate.ts` `calibrate`), and the manual boost (`signals.boost`).
- What is ignored: Not-now reasons (`contract/work.ts:161`), snoozes, dismissals, cards ignored for days and "move to #1" in chat never change weights or rules. `relevance_feedback` is for brief highlights and unused by code.
- *Tenet: Suggest, then learn* is met for closures and mappings, not for priority.

**PRIO-15 · minor · Nothing tests whether it is the right list.**
- What exists: the priority tests check invariants and mechanics (`tests/engines/priority/*`), and Home tests check the build (`tests/home/build.test.ts`).
- What is missing: no test asks "for this realistic day, is the Top N right?"

## 4. Recommendations (prioritized)

**R1 · S · Fix overdue semantics and the why text (PRIO-1, 13).**
- Overdue *hard* items keep urgency 1 for one working day after the deadline, then decay to 0.6 and show in Chase as "Late: do now or re-date".
- Overdue *soft or inferred* items drop to 0.4 at once and get a "Re-date or drop" verb.
- Overdue text reads "2 d late", never "start by Mon".
- Exclude likely-done items from ranking (they wait in Looks done).
- No contract change. Bump `PRIO_ENGINE_VERSION` to `priority@1.1`.

**R2 · S · Pass the dropped inputs and stop the overwrite (PRIO-6, 9).**
- Map `importance`, `dueKind`, `askedAt` (the origin evidence's time) and `people.tier` into `PriorityItem`.
- Set `from_manager` only when the manager is the asker or counterparty.
- Stop writing `priorityFor(rank)` into `importance`: make contract `priority` a derived view field and add `importance` to `WorkItemRecord`.
- Migration: none for columns. Importance values already overwritten cannot be recovered (the history is in `audit_events` if it matters). Accept and move on.

**R3 · M · One decision for both pages (PRIO-4, 7).**
- Home's Do now = the engine's day plan head (R5), under the same `rerank()` stability as Today.
- Remove the Outbox-at-#2 splice. A draft rides on its item's card ("Review draft", already `itemVerb` `build.ts:639`). Drafts with no ranked item go into a single **Respond** batch row ("6 replies drafted, ~20 min").
- Coordinate with UI-AUDIT on the look. The rule is: a draft's rank = its item's rank.

**R4 · M · Re-rank automatically, display stably (PRIO-5).**
- A worker hook runs the deterministic rank after each scan batch or closure pass (debounced 2 min, trigger `new_info`; the enum already exists, `migrations/0001_init.sql:89`).
- It writes scores and start-by. `rerank()` keeps the shown Top 3 stable and pre-empts only when an item becomes "late unless started".
- The pill remains for "n would move". It costs no LLM spend. It is compatible with D-73 (the order on screen moves only on Apply or pre-emption), so it is not a blocker.

**R5 · M–L · A plan-backwards scoring model (PRIO-1, 2, 3, 8, 10). The core change; spec in §4.1.**
- Depends on SCANNER (the extractor adds `size` and `awaiting` fields) and TIME (admin classification).

**R6 · M · Make admin a quiet batch (PRIO-12).**
- Classify `admin_class` deterministically: origin `system_rule`, closure kinds `vdp_readback` and `org62_readback`, and gap-rule kinds, replacing the title regex.
- Admin items leave the main ranking unless due within 48 h or a pay-linked deadline is at risk. Home shows one "Admin: 4 items · ~25 min · next due Fri 16:00" row that links to Time. Log & fix keeps its role as that surface.
- Depends on TIME and UI-AUDIT.

**R7 · S · Make the card why the ranking's why (PRIO-11, 13).**
- Two short parts generated from the formula's top terms: *Why it matters* (who, deal, kind) and *Why now* (deadline, start-by, free time).
- Keep the extractor's `why` as the detail line.
- Decide NBA's fate separately (§5). Ranking must not depend on it.

**R8 · M · Capture feedback and replay it (PRIO-14, 15). See §4.4.**

**R9 · S · A golden-day harness (PRIO-15). See §4.4.** Build it before R5 so R5 is measured.

### 4.1 Target scoring model (priority@2)
Deterministic core. A cheap model is used only where judgment is needed, and only inside the existing extraction call (no extra calls).

**Per-item derived facts** (computed on every rank; cached on the item):
- `needBy`: the earliest of the due date (hard, soft, inferred), the start of the served meeting, the reply SLA (R6 below) and the prep-rule deadline. Its source is kept for the why.
- `effortMin`: the item's own estimate. Otherwise the size class from the extractor (XS 10 / S 30 / M 90 / L 180 / XL 360 hands-on), else the kind default, then calibrated (the existing `calibrate`). Agent minutes stay separate (*Hours are human hours*).
- `startBy`: **walk backwards from `needBy` through free working intervals** (accepted meetings removed, a reserve kept) until `effortMin` fits. The horizon is 10 working days, and meetings are fetched to match. `slackWorkMin` = free working minutes between now and `startBy`.
- `blockedBy`: from `work_item_relations.blocks` (already in the enum, `migrations/0001_init.sql:136`) and waiting-on-others. A blocked item cannot be in Top N; its blocker can.

**Value V (0–100)**, independent of time:
`V = 40·who + 30·deal + 20·kind + 10·goal`

| Term | Values |
|---|---|
| who | the asker or counterparty first: leader or customer exec 1, manager .9, customer .8, AE .7, partner .6, teammate .5, other .3 |
| deal | none 0; < $100k .3, < $500k .5, < $1M .7, < $3M .9, ≥ $3M 1. × stage factor (early .7, late 1). +0.1 if the close is in the current quarter (cap 1) |
| kind | promise 1, prep or build for a customer meeting 1, direct ask .9, follow-up .7, internal task .4, admin .3 |
| goal | pay-linked admin (DC, logging) with its deadline at risk .8; else 0 |

The judgment calls go to the cheap model *inside extraction*: "is this a real ask of me?" (already done: confidence and Still-needed), "how big is this?" (size class), and "is it waiting on me?". No per-rank LLM calls.

**Urgency U (0–1)**, from working slack rather than wall clock:

| Situation | U |
|---|---|
| startBy passed or now (and needBy ahead) | 1.0 |
| startBy later today | 0.8 |
| startBy next working day | 0.5 |
| within 3 working days | 0.3 |
| later | 0.1 |
| no needBy | 0.05 |
| overdue hard, < 1 working day | 1.0; then 0.6 plus a Chase "re-date" |
| overdue soft or inferred | 0.4 plus "Re-date or drop" |

**Priority** `P = V × (0.25 + U)`, plus policy boosts and penalties (kept as they are), `userAdjustment`, and the existing never-above, lane-floor and exclude rules. Ties break on startBy. Multiplying stops a low-value thing from jumping a high-value one *only* because it is late, while urgency still dominates within similar value. The policy DSL and versioning stay. The new weights become a `priority@2` role template.

**Explanation contract:** `matters` = the top two V terms ("Brendan (customer) · $780k renewal"); `now` = the U bucket in plain words ("Demo Thu 10:00 needs ~3 h; only 1 h free before it → start today by 13:00"). Both come straight from the terms, so the why is true to the formula (*Legible*).

### 4.2 Daily plan structure (what Home and Today both render)
1. **Free today** F = free working minutes − reserve (persona, default 20 % for interrupts).
2. **Must-today** M = items with startBy ≤ the end of today, ordered by P. If Σ effort(M) > F, the day is **overbooked**. Show the lowest-V items of M with "Renegotiate / move" and never claim "fits".
3. **Top N** = the head of M that fits F, N ≤ 3 cards (fewer when the day is full: calm). "Later today" holds the rest of M.
4. **Respond** (first-class): people waiting on me, ordered by owed age × who, with drafts inline. One row with a count and minutes ("5 replies · ~25 min · oldest Nadia 1 d"). An owed reply past its tier's SLA joins M.
5. **Kick off**: agent runs whose startBy is today (background minutes shown separately).
6. **Coming builds**: items whose startBy falls in the next 5 working days, each with "start by Tue". This is what answers "when do I need to start the build".
7. **Waiting on them** (Chase, unchanged) and **Admin batch** (R6), both quiet unless they are due.

A brief nod to other products (UI-RESEARCH owns the detail): Motion schedules tasks backwards into the calendar from deadline and duration; Sunsama warns when the planned time exceeds the day's capacity; Linear keeps triage separate from the ranked queue. This model takes the backwards schedule and the capacity warning, without writing to the calendar (*Nothing leaves without approval*).

### 4.3 Data additions and migration (0027, additive)

| Change | Notes and migration |
|---|---|
| `work_items.size_class` enum xs…xl, null | Written by the extractor (scanner lane adds it to the output schema). Null falls back to kind defaults. |
| `work_items.awaiting` enum me / them / none, default none; `last_inbound_at`, `last_outbound_at` tstz null | Backfilled once by a deterministic job from evidence: the latest origin or progress author is me or not me. Kept current by the closure pass. Replaces the "Claude waiting = waiting_on_me" overload (keep that status for sessions). |
| `work_items.need_by_at`, `need_by_source` enum due / meeting / sla / reply_sla / prep_rule | Derived cache, written with each rank. |
| `work_items.admin_class` text null | Deterministic classification (R6). Backfilled at the first rank after the migration. |
| `priority_scores.value`, `urgency` numeric, `components jsonb` | Old component columns are left null for `priority@2` rows. `engine_version` tells them apart. |
| `priority_runs.inputs jsonb` (or a side table `priority_run_inputs`, 30-day retention) | Needed for replay. Local data only. Never logged (*Local data, privacy-safe logs*). |
| new `priority_feedback` (id, owner, work_item_id, run_id, shown_rank, surface, action enum thumbs_up / thumbs_down / should_be_higher / should_be_lower / missing / done_from_card / ignored_nd / dismissed / snoozed, reason, created_at) | Append-only. |
| contract: `WorkItemRecord.importance` (new), `priority` stays derived | `db/store/work.ts:295,403` stop the round trip. |
| policy: role templates `role:se_ic@2`, `role:ae@2`; the per-user policy gets a version + 1 with changeSummary "Priority model 2" | Custom rules carried over. Weights for priority@1 are kept on the old row. |

Rollout for people already running it: `npm run update` runs the migration. Priority@2 first runs in **shadow** (computed and stored, diffed against priority@1, with the diff shown in Settings ▸ Role & rules through `previewPolicy`). A setting switches it on. Revert = switch back, with no data loss.

### 4.4 Persona config (D-55: the preset pre-fills, the user's changes are stored)
Add a `priority` block next to `duties` and `thresholds`:
```
priority: {
  template: 'se_ic@2', topN: 3, reservePct: 20,
  replySla: { customer_exec: '4wh', leader: '8wh', customer: '8wh', manager: '24h', ae: '24h', teammate: '48h' },
  dealTiersUsd: [100_000, 500_000, 1_000_000, 3_000_000],
  prepRules: [ { when: 'customer_facing && title~/(demo|poc|workshop)/', leadWorkDays: 1, size: 'L', create: 'Prep: {meeting}' },
               { when: 'title~/(qbr|readout|exec)/', leadWorkDays: 2, size: 'M' } ],
  admin: { classes: ['logging','dc','vdp','use_case','expense','training'], payLinked: ['logging','dc'], promoteWithinH: 48 },
  overdue: { hardGraceWorkH: 8, soft: 'redate' },
}
```
- Prep rules create a deterministic **prep item** (origin `system_rule`, closure: the meeting starts) for a customer-facing meeting with no linked prep. That item flows through `startBy` like any other.
- The AE preset differs in its deal tiers (forecast emphasis) and prep rules (pricing and forecast-notes cadence).
- *Config over code* is preserved.

### 4.5 Evaluation: is it the right list?
- **Golden days (R9).** Fixtures built from `sample-data/tables` through **the same mapping as `db/rank.ts` `priorityInputs`** (extract it to a pure shared builder, so the test can't drift from prod). Each golden day sets `now` and lists:
  - must-be-in-Top-N ids (sample day: wi-060, wi-031 or wi-032, wi-015/wi-003);
  - must-not-be-in-the-first-screen ids (wi-044, the VDP admin items);
  - order constraints (wi-032 above wi-042);
  - "capacity must say overbooked or fits" expectations;
  - must-contain phrases in the why.

  Five days to start: the sample Wednesday; Friday blueprint day (11-20 07:30); an onsite day (11-23); a quarter-end week (synthetic shift of the sample); a first-scan day (nothing ranked). These are pure unit tests that run in milliseconds (helps the TESTING lane's isolation goal).
- **Metrics** per golden day and overall: agreement@3, must-not-miss recall (every item with startBy ≤ today is in the plan), the admin share of the first screen, and stability (moves without a user act). CI gate: no engine or policy change may lower the golden pass rate.
- **Owner feedback in-app.** Thumbs up or down on each Do-now card. "Should be higher or lower". A "Something missing?" picker (search open items) on the Do-now header. Implicit signals: the card was done today, ignored 3 days, snoozed or dismissed with a reason. All go to `priority_feedback` with `run_id`, so the inputs are known.
- **Replay.** `npm run priority:replay -- --since 14d` re-runs the current engine and policy over stored run inputs and reports the agreement with the feedback (and with the golden days). Proposed weight or rule changes appear as a **policy suggestion with `previewPolicy` before/after**, never applied silently (*Suggest, then learn*). The D-56 Slack feedback post can carry a weekly "priority agreement" line for teammates.

## 5. Decisions for Tristan

1. **Overdue semantics.** (a) Keep the maximum urgency forever (today). (b) Decay after one working day, with soft and inferred dates going to "Re-date or drop". **Recommend (b).**
2. **Drafts on Home.** (a) The Outbox card at #2 (today). (b) Each draft rides on its item's card, and the rest go into one Respond row. **Recommend (b).** It fixes the "long list of drafts" at the decision level.
3. **Admin placement.** (a) Mixed into ranking (today). (b) A quiet batch, promoted only when due within 48 h or a pay-linked deadline is at risk. **Recommend (b).** You can adjust "pay-linked" per persona.
4. **Size estimation.** (a) Deterministic kind defaults only. (b) The extractor adds a size class in the scan call it already makes (a cheap model, no extra call). **Recommend (b).** It needs the SCANNER lane's schema change.
5. **Prep creation from the calendar.** (a) Only explicit prep asks (today). (b) Persona prep rules auto-create prep items for customer-facing meetings with no linked prep. **Recommend (b),** with a per-rule "Not needed" (D-61 mechanism).
6. **NBA engine.** (a) Wire per-item NBA generation (a cost per item; owned by the TOKENS lane). (b) Keep NBA for on-demand drafts and read-ins only, and take ranking and the why from the engine. **Recommend (b)** for prioritization. Either way, the ranking must not depend on NBA.
7. **Auto re-rank.** (a) Explicit apply only (today). (b) Auto-score after scans, stable display, pre-emption only. **Recommend (b).** It stays inside D-73's "never move what is on screen".

None of these conflicts with a tenet. Fewer than 3 cards on an overbooked day still honours *Calm* ("the next 3 things" is a ceiling).

## 6. What's fine, don't touch
- The pure, deterministic engine with versioned policy, inputs hash and per-component reasons (`score.ts`, `policy.ts`). Its predicate DSL and rule kinds (`never_above`, `lane_floor`, `sla`, `exclude`) are a good, explainable base; extend it, don't replace it.
- Top-3 stability and pre-emption (`stability.ts`), and the "Re-rank ready" diff.
- The split between agent and hands-on minutes and the "agent never counts" capacity rule (*Hours are human hours*).
- Effort calibration from actuals (`estimate.ts` `calibrate`). Extend its inputs to completed-card timings.
- Chase: waiting-on-others with since and nudge timers, and promise folding by initiative.
- "Still needed?" for stale-on-arrival asks (`still-needed.ts`), which keeps first-scan noise out.
- The needs-decision mechanism (D-61) for setting rows aside.

## 7. Open questions / not verified
- I did not run Postgres. Home's first screen is emulated from `build.ts` rules over the engine's output, not rendered. Held-by-meeting prep and the gap-rule consumption were not emulated exactly.
- In my mapping, items linked to their own focus blocks via `prep_for` (the blueprint's "deadline" became its Fri 11:00 focus block). I did not verify how often prod `e.prep.workItemId` points at a focus block. If it does, that is another start-by distortion.
- How loosely the live extractor fills `lead_time_minutes` (it drives the agent minutes, and so the leadTime points and the kick-off sequencing) needs a look at live rows. The sample's values may be generator noise.
- Whether people's `role` text in prod reliably carries "RVP / VP / Director" (tier inference) is unverified. `people.tier` is in the DB but unread.
- The AE persona's day was not evaluated. The same structural findings apply; its deal-tier and forecast weighting needs its own golden day.
