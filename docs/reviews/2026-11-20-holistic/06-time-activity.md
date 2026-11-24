# 06: Time, activity, DCs and use cases (owner's ask #6)

Reviewer lane: TIME-ACTIVITY (`TA-n`). Read-only. Code at `3533cb6`. Mock UI checked on :4350 (`/activity`, `?view=needs`, `?view=usecases`). Sample data: `sample-data/tables/*.json`. Nothing external was called.

## 1. Summary

1. **The round trip is solid. The guessing is weak.** The Org62/VDP round trip (D-65/D-67/D-68/D-70) is well built and tested: all 97 TL/DC/UC/VD rows in `docs/EDGE-CASES.md` read OK. Ask #6 is about what comes before it: which opp, which DCs, which use cases. That is where the app is thin.
2. **Attribution is split across three rankers that don't share signals.** They are the projection's `Matcher` (`src/projections/matching.ts`), Time's `opp-options` plus `time-suggest` rules plus Haiku (`src/lib/opp-options.ts`, `src/lib/time-suggest.ts`), and the DC sweep's token narrowing (`src/engines/deals/evidence.ts`). They can disagree about the same row on the same screen. None of them learns from your accepts. `mapping_rules` exists in the schema with `source: user_correction` and `hit_count`, but no code reads or writes it (TA-1, TA-2).
3. **A brand-new deal is invisible to the suggester.** Candidates come only from the local mirror: opp teams I'm on, accounts already in the app, opps I own. A live Org62 search exists, but only when you type into the picker (TA-4). Slack is attributed by channel-name words only, because the channel map is never passed in (TA-3). One row gets one opp and one suggestion, with no ranked list and no multi-opp DC (TA-5).
4. **DC and use-case suggestions lag by weeks, and "AEs I cover" doesn't exist.** DC gaps count hours **already logged in Org62** (`src/projections/run.ts:421-426`). Use cases wait for a **100% DC** (D-63/D-67). So a new deal runs meeting → canvas → Slackbot → read-back → DC claim → canvas → Slackbot → read-back → use case → canvas. The missed-opp sweep is hard-coded to D360 products. Covered AEs have zero code, though the seams exist (TA-6, TA-7).
5. **The rules can't be predicted.** D-59..D-72 run to about 47k characters. D-67 is amended three times and then again by D-72. State is carried in English flag strings that regexes parse back (`time-suggest.ts:147`, `classify.ts:83`). Personal keywords sit in the classifier (`classify.ts:21`). The fix is a single attribution engine (rules first, a live Org62 lookup when nothing fits, Haiku only for close calls, learning from every accept), an engagement table that drives DC and use-case suggestions, and one weekly review page of checkboxes (§4).

## 2. How it works today

### 2.1 Time: evidence to verified Event

```
calendar_events / claude_sessions(cwd) / drive edits / slack msgs / sent email / git
   │  src/projections/run.ts (Matcher: names, aliases, learned meeting domains; repo→account = first session's account, run.ts:894-899)
   ▼
engines/activity/blocks.ts ─ engaged.ts (solo work = own actions) ─ classify.ts (keyword table → task type; account → ONE whatId, matching.ts:362-375)
   ▼  propose.ts → activity_entries (status needs_input|proposed|approved|…; flags = English strings)
   ▼  read time: lib/time-suggest.ts  rules (fixed confidences 0.92…0.5)  ≥0.75 settles
   │            else jobs/handlers/activity-suggest.ts → Haiku, 1 call/row, ≤15/pass, kv cc.time.suggestions
   ▼  UI: Activity ▸ Org62 ▸ Needs you (Accept / picker / "Search Org62 for …") → Log it (tick) 
   ▼  POST /time/log/batches → Outbox slack_canvas.create item (lib/canvas/preflight.ts re-checks on Apply)
   ▼  Apply → outbox/adapters/canvas.ts creates private canvas (engines/activity/slackbot.ts work order, CC#<rowId> in Description)
   ▼  HUMAN in Slack: "Execute this canvas" → Slackbot writes Org62 Events
   ▼  org62:events scan (every 60 min in work hours) / rechecks at 5-15-30-60 min after "Copy Slackbot prompt" (db/index.ts:1617)
   ▼  / org62.readback daily 06:40 by Id → projectWeek: logged → verified | verify_failed ("Not in Org62", "Deleted in Org62")
```

### 2.2 DCs

```
scan-org62 book (daily) + dcs (60 min) + missed_opps (daily: Event hours by WhatId → D360 line items → DCs, scan-org62.md:149-178)
   ▼ engines/deals/findings.ts (Claim/Check/Skip) + needs.ts dcGapOf (open, no DC, no request; team | ≥1 h Org62-logged | sweep claim | VDP)
   ▼ Deals ▸ Log & fix row / Missed ▸ "Claim N selected" → components/deals/ClaimDc.tsx (split default 100%, role, comment)
   ▼ deal_contribution_requests (approved) → ride on the next logging canvas (server/deals/dc-requests.ts withDcAdds)
   ▼ Slackbot → Org62 read → reconcileDcRequests (verified | not_created | changed_in_org62)
```

### 2.3 Use cases

```
VDP mirror (vdp_records) ⇄ org62_use_cases (org62.readback: Use_Case__c by Opportunity__c, 20 opps/query)
   ▼ engines/activity/use-cases.ts: scope = open opp with MY 100% DC (D-63); match link → opp+title; drift vs synced_*
   ▼ VDP→Org62: a row on the next logging canvas (D-67/D-72) · Org62→VDP: create_use_case Outbox item in the VDP tree
   ▼ lib/landings + server/landings: record_landings / landing_writes (neither / one / both / differs)
   New use cases come only from what you type in VDP, or from nba-update-vdp (Sonnet, one item at a time). No sweep.
```

### 2.4 Clicks in a normal week (estimate from the code paths, not measured)

Assumed week: about 25 rows, 6 in Needs you, 2 new DCs, 2 new use cases.

| Step | Clicks | Thinking left to the owner |
|---|---|---|
| Needs you: "Accept N suggestions" | 1–2 | Is a 0.5 "a guess" right? (screenshot: "Someone from globex.example… the one you logged to last · 50%") |
| Rows with no or wrong suggestion: picker, type, Search Org62, pick | about 4 × 2 | Which sibling opp? Does the deal even exist in the app? |
| Internal rows / Not in Org62: Log again or Leave out | about 4 | – |
| Log it → Log these rows → Review & apply → Apply → Copy Slackbot prompt | 4–5 | – |
| In Slack: open canvas, Slackbot, paste, send | about 4 (outside the app) | – |
| Deals: per DC gap → Claim DC → confirm split/role/comment → submit | about 4 × 2 | Which opps deserve a DC? (only shown after hours reach Org62) |
| Use cases: VDP ▸ Changes push, then after the 100% DC, tick on Log it, then canvas again | about 4 × 2 | What use cases did we discuss? Which opp? |
| **Total** | **about 40 clicks, 4 surfaces (Activity Org62, Activity VDP, Deals, Slack), 2–3 canvases** | |

## 3. Findings

**TA-1 (major): three attribution engines that disagree.**
- **What happens.** A row's opp is set three ways:
  - (a) at projection time by `Matcher.oppFor` and `mappings()`. Each account carries exactly **one** whatId: its distinctive-word opp, else my only team/DC opp, else the account (`src/projections/matching.ts:330-375`).
  - (b) at read time by `buildOppOptions` tiers (`src/lib/opp-options.ts:44-47`) and `ruleSuggestion` with fixed confidences (`src/lib/time-suggest.ts:31-42, 167-221`).
  - (c) for DCs, by `narrowEvidence` with its own stopword list (`src/engines/deals/evidence.ts:15-24`).
- **Three tokenizers too.** There are three tokenizers and stopword lists: `GENERIC` (`time-suggest.ts:113`), `DEAL_WORDS`/`isGenericMatchWord` (`matching.ts:227`), and `STOPWORDS` (`evidence.ts:15`).
- **The two systems contradict each other.** The domain signal reaches `time-suggest` only by regex-parsing the human flag text "CF forced: external attendee (…)" (`time-suggest.ts:147-153`). In the mock Needs you tab, "Data 360 roadmap call" shows the engine's issue "A meeting with no account" right above the suggestion "Someone from globex.example was there (Globex)". The two systems contradict each other on one row.
- **Why it matters.** *Legible*: you can't predict the guess. It also blocks any learning (TA-2), because there is no single place to learn into.

**TA-2 (major): nothing learns from accepts or picks (*tenet: Suggest, then learn*).**
- **Accepts and picks don't write rules.** Accept and pick are `PATCH /activity/:id` plus a field lock. No alias or rule is written. `account_aliases` is inserted only on an account merge (`src/server/datasource/db/store/deals-sync.ts:169`).
- **The rule table is dead.** `mapping_rules` has `kind` (domain_to_account, channel_to_account, repo_path_to_account, title_token_to_account…), `source: user_correction`, `hit_count` and `last_hit_at` (`src/db/schema/entities.ts:336`; 32 sample rows). Only `src/server/events/topics.ts:88` references it. No reader, no writer.
- **What learns today.** Only two things:
  - opp recency, via `lastUsed` over 30 days (`opp-options.ts:90-96`);
  - domains learned from meeting titles that already name an account (`src/projections/run.ts:332`).
- **Effect.** The same Slack channel, repo or recurring series asks again every week.

**TA-3 (major): Slack and repo attribution are mostly blind.**
- **Slack.** `Matcher.mappings` returns `channels: extra.channels ?? {}` (`matching.ts:375`), and the only caller passes `{ repos }` (`run.ts:1030`). So `m.channels[channelId]` is always empty. Slack maps only when a channel *name* contains an account name or alias (`src/engines/activity/blocks.ts:117`).
- **Sample data agrees.** In the sample data, 48 of 48 `slack_burst` time blocks have no account or opp (`sample-data/tables/time_blocks.json`). That's synthetic, but it matches the code.
- **Repos.** A repo maps to the account of whichever session in that `basename(cwd)` was seen first (`run.ts:897-899`).
- **Not used at all.** Channel participants (who from the customer or the AE is in it) and Claude session titles or task opps beyond the linked work item (`opp-options.ts:68-71`).

**TA-4 (blocker for "looped into a new deal"): the candidate universe is the local mirror.**
- **What the mirror holds.** The opps scan reads OpportunityTeamMember where `UserId = me`, opps on accounts already in the app (up to 200 ids), and opps I own (`skills/scan-org62.md:45-57`; the book reads the same, `:130-140`).
- **The new-deal case.** Take a meeting with a new customer's domain on a deal where I'm not on the team yet. It has no account, so it has no candidates. Haiku then receives the top 15 of an unrelated ranking: open, recently used, mine, closing soon (`src/engines/activity/suggest-prompt.ts:39-43`, `src/server/datasource/db/index.ts:1695`). It can only pick a wrong opp or say internal.
- **The search exists but is manual.** A good live search exists: `buildOrg62OppSearch` (`src/server/chat/org62.ts:84-94`), `POST /time/opps/org62-search`, and `pickOrg62Opp`, which adds the opp and account in one change set (`db/index.ts:1900-1990`). But only the picker calls it, and only when you type (`src/components/time/OppPicker.tsx:97`). Nothing runs it from evidence: domain → Account.Website, attendee email → Contact → OpportunityContactRole, title tokens → Opportunity.Name.

**TA-5 (major): one row, one opp, one suggestion.**
- **Single values.** `ActivityEntry.oppId` and `suggestion` are single (`src/contract/time.ts:73, 117`).
- **Only empty rows get a suggestion.** Suggestions exist only for rows with **no** opp (`time-suggest.ts:78`). A row the projection mapped by fallback ("my only open team opp on the account", `matching.ts:340-341`; "WhatId = account fallback") gets no alternatives and no reason ranking.
- **No multi-opp DC.** There is no way to say "logged to opp A, but I contributed to A and B". Org62 Events have one WhatId, so this must not split hours (*tenet: Hours are human hours*). But nothing feeds "touched opps" to DC suggestions either.

**TA-6 (major): DC suggestions are late and product-locked.**
- **Late.**
  - `hoursQtd` is my hours on **Org62 Events** this quarter (`run.ts:421-426`). `dcGapOf` needs ≥ 1 h of them, or team membership, a sweep Claim, or a VDP (`src/engines/deals/needs.ts:74-87`).
  - The sweep starts from Org62 Event hours (`scan-org62.md:155`). Approved app rows, meetings, Slack and sessions never make a DC suggestion until they have gone through a canvas and Slackbot.
  - Use cases then wait on "your 100% DC" (D-67; mock: "No open opportunity with your 100% DC on this VDP or its account (D-63)").
- **Product-locked.** The sweep's candidates are D360 line items or names only (`src/engines/deals/classify.ts:13-19`, `scan-org62.md:161-165`). An Agentforce SE or another team gets nothing (*north star: Low upkeep, team-portable*).
- **One at a time.** The Deals gap row claims one opp at a time. Only Missed has "Claim N selected" (`src/components/deals/MissedView.tsx:308`).

**TA-7 (major): "AEs I cover" is absent.**
- **No code.** A grep for covered, aligned or my AEs finds no setting, job or query.
- **Seams that exist:**
  - `myOppTeam(userId)` SOQL builder (`src/engines/deals/soql.ts:73-76`);
  - `opportunity_team_members` already models non-me members (`person_id`, `org62_user_id`, `team_role`; `entities.ts:206`). Only `is_me` rows are written (`store/projections.ts:185-193`); the sample has 50 AE rows.
  - the fixed-SOQL, kv-cached job pattern of `vdp.specialist_aes` (`src/jobs/handlers/vdp-specialist-aes.ts`).

**TA-8 (major): rich signals unused for attribution, DCs and use cases.**
- **Gemini notes.** They are read by Haiku only to write the Description (`src/jobs/handlers/activity-notes.ts:1-7`). The same call could return the opp or account named, use-case mentions and DC evidence.
- **Unused Org62 reads.** OpportunityContactRole and Contact are allowed for the Assistant (`src/llm/chat/soql.ts:22`) and never used by scanners.
- **Other gaps.** Recent DC activity of other SEs on an opp (the "split conversation" signal) appears only in the sweep's step 3. The opp's team (who the AE is) is not compared with meeting attendees or Slack members.

**TA-9 (minor): the Slackbot hop adds avoidable waits and dead config.**
- **Late rechecks.** Fast read-back runs only when the user clicks "Copy Slackbot prompt" or "check now" (`db/index.ts:1617-1650`). Apply alone waits for the 60-min `org62:events` cadence (`src/scanner/runtime/cadence.ts:17, 49`).
- **Dead setting.** Automatic mode stages at a hard-coded 17:30 (`src/worker/schedules.ts:42`). `logging.autoAt` is declared (`src/contract/settings.ts:372`) and read nowhere.
- **The hop itself is fine.** The human hop is the price of *Nothing leaves without approval* plus "the app never writes Org62". Keep it, but make it one per week (§4d).

**TA-10 (major): too many counts and states on one page.**
- **Counts disagree.** The mock Activity header says "6 rows need you" while the tab says "Needs you 7" and the sidebar 7. The quarter card shows six numbers (14 h, 46 h to go, 14.25 h, 8.75 h, 2 h, 3.5 h) plus a red "Not in Org62 yet" banner.
- **States.** Rows carry 11 statuses in the sample: needs_input, proposed, approved, synced_to_canvas, logged, verified, verify_failed, excluded, dismissed, upcoming, dropped.
- **Use cases are scattered.** They live under Org62 ▸ Log it, Org62 ▸ Needs you, Org62 ▸ Use cases and VDP ▸ Changes. A use case that is "Org62 only" says "adding it to VDP is an item in Activity ▸ VDP", which is another tab.
- **Decision ids in copy.** The UI copy shows decision ids ("(D-63)").
- **Lanes.** Overlaps with lane UI (ask #1).

**TA-11 (major): the rules are too intricate to predict.**
- **Size and amendments.** D-59..D-72 total about 47k characters (D-67: 5.3k, D-65: 4.5k, D-69: 4.5k). D-67 is amended three times and then partly overridden by D-72 ("amends D-67's never a canvas of their own", "Stage / Go-Live only"). D-18 carries a struck-through rule.
- **The hold rule is written four times:** D-47, D-65, D-67, D-68.
- **State lives in prose.** `NOT_ON_TEAM_MARKER` substring matching (`src/engines/activity/classify.ts:83-90`), the 25 regexes of `plainIssue` (`src/lib/time-issues.ts:60-95`), and the domain scrape (TA-1).
- **Personal keywords in code.** The classifier holds personal and team keywords in code: `meshmesh|claudeforce|lsjdo|life sciences|headless|\bace\b` (`classify.ts:19-26`). That violates *Config over code for people and teams*.
- **Result.** A teammate can't predict why a meeting became Admin, Asset Creation or "needs an opp".

**TA-12 (minor): confidences are labels, not measurements.**
- **Labels.** Fixed per-rule numbers (`time-suggest.ts:31-42`) and a 0.75 settle line. Nothing records accept and override rates per rule or basis, so neither the threshold nor the model's self-reported confidence can be checked.
- **The data is there.** The audit trail has it: the accept is a PATCH with `oppId` and the suggestion that was shown.

**TA-13 (minor): stale guidance contradicts D-67.**
- `skills/nba-update-vdp.md:42` says "Share the use-case CSV with the AE (the AE owns the Use Case object)". `docs/BACKLOG.md` B-055 says the same.
- D-67 decided OwnerId = me, created via canvas. An agent following the skill gives the wrong follow-up.

**TA-14 (major): no use-case capture.**
- **Where use cases start.** A new use case starts only in VDP: the tree's "Add a use case", or Org62 → VDP for records that already exist. `nba-update-vdp` (Sonnet, `skills/nba-update-vdp.md:4`) proposes adds per item on demand.
- **What's missing.** There is no sweep that turns meeting notes or Slack into use-case **candidates**. There is no candidate list deduped against both systems, and no "rundown of opps" when the target opp is unclear.

## 4. Recommendations (prioritized)

Effort: S < 1 day, M 1–3 days, L > 3 days.

| # | What | Effort | Depends on |
|---|---|---|---|
| R1 | One attribution engine (§4a) replaces `time-suggest` rules, `opp-options` tiers and `Matcher.oppFor` for rows | L | lane data model (#8) for the table names |
| R2 | Learn from every accept: write `mapping_rules`, read them first | M | R1 |
| R3 | Live Org62 discovery when no candidate ≥ 0.6 | M | R1; lane cost (#3) for budget |
| R4 | `opp_engagement` weekly aggregate, which feeds DC suggestions and the rundown | M | – |
| R5 | DC suggestions from engagement, plus covered AEs, plus a daily "claim these" batch | M | R4, R7 |
| R6 | Use-case candidates: capture, dedupe, one table, "Add to VDP + Org62" | L | R4; D-T1 below |
| R7 | Settings ▸ Deals ▸ AEs I cover, and the `deals.covered_aes` job | M | – |
| R8 | Weekly review surface (§4d) | L | lane UI (#1) |
| R9 | Auto-queue Org62 rechecks on canvas Apply; honor or remove `autoAt` | S | – |
| R10 | Typed issue codes instead of flag strings; personal keywords to the team pack | M | lane maintainability (#11) |
| R11 | Fix `nba-update-vdp.md:42` and B-055 (TA-13) | S | – |
| R12 | Rule set (§5) replaces the D-59..D-72 prose in docs; decisions keep history only | S | orchestrator |

### 4a. Attribution engine: a ranked list per row, with reasons (R1–R3)

- **Home.** `src/engines/attribution/` (pure). Input: a row's evidence plus the context. Output: `candidates: {oppId|internal, accountId, score 0–1, reasons: {signal, weight, text}[]}[]`, top 5.
- **Signals.** Deterministic. The weights are config, not code:

| Signal | Source today | Weight (start) |
|---|---|---|
| Learned rule hit (domain, channel, repo, series, title token → account/opp) | `mapping_rules` (R2) | 0.9 opp / 0.7 acct |
| Meeting's own opp (Event or invite links it) | `evidenceTies` | 0.9 |
| Attendee email → Contact → OpportunityContactRole | new read (R3) | 0.8 |
| Attendee domain → account (aliases, learned, `Account.Website`) | Matcher domains | 0.6 acct |
| Opp team overlap: the opp's AE/SE is an attendee or channel member | `opportunity_team_members` (non-me rows, R7) | 0.5 |
| Channel id → account (rule), channel name words | blocks.ts | 0.6 / 0.35 |
| Repo or session cwd → account; session's work item opp | run.ts repos, runs | 0.6 / 0.85 |
| Distinctive opp-name words in the title or notes | Matcher.oppTokens | 0.5 |
| Notes name an opp, account or product (R6's extraction) | activity.notes | 0.5 |
| Recency: I logged or approved this opp in 30 days; it's open; it's mine | opp-options | 0.15 each |
| Closed > 90 d, amount 0 | – | penalty |

- **Scoring.** Combine per candidate as `1 − Π(1 − wᵢ)`, reasons kept. An account-level score spreads to its open opps by "only open opp", "mine", "distinctive word", "recent". The engine shows the row's top 3 with reasons as chips. Accept takes #1 or any alternate in one click.
- **Live discovery (R3).** When the best score is under 0.6 and the evidence names something (an external domain, an attendee email, a 2+ word title), the job `attribution.discover` (queue `engine`) runs at most 3 fixed SELECTs through `runOneReadLookup`:
  - `Contact` by email to `OpportunityContactRole` (open opps);
  - `Account` by `Website LIKE '%domain%'` or `Name LIKE`;
  - `Opportunity` open on those accounts.
  - Each query is cached in kv by hash for 7 days, and the pass is capped (for example 20 lookups a day).
  - Hits become "discovered" opps through the existing `putOrg62Opp` path (`db/index.ts:1981`), marked `ext.via = 'discovered'` and kept out of my book and Deals until used. The engine re-scores them.
  - Read-only, `soqlQuery` only, no allowlist change (§6).
- **Haiku (D-71 kept).** Only when the top two are within 0.15 and the top score is under 0.75. The prompt gets the top 8 **ranked** candidates with their reasons, not 15 unrelated opps. The kv cache and hard cap stay.
- **Learning (R2).** On accept or pick (`PATCH /activity/:id` with `oppId`, or `internal`), the engine writes one `mapping_rules` row for the strongest *generalizable* signal of that row: domain → account, channel id → account (or opp when the account has many opps and the channel only ever goes to one), repo → account, recurring series id → opp, internal series → internal. The source is `user_correction`, and `hit_count` is bumped on reuse.
  - A rule never overrides a locked field.
  - The rule's own reason shows ("Learned 11/12 from your pick: #acme-ext → ACME").
  - Settings ▸ Time ▸ Learned rules lists them with Remove (*Suggest, then learn*: one-click corrections become rules).
  - Migration: none for the table (`0001_init`). Add `opportunity_id`-level rules: the column exists.
- **Calibration (TA-12).** Store `{basis, rule, shown_confidence, accepted: bool}` per suggestion outcome in `llm_decisions`, or a small `suggestion_outcomes` table (additive). Health ▸ Time shows the accept rate per rule. Tune the weights by data, not by decision prose.

### 4b. DC suggestions, automatic (R4, R5, R7)

- **`opp_engagement` (new table, additive migration).** One row per `(owner, opportunity_id, iso_week)`:
  - `app_hours` (approved, logged or verified rows), `org62_hours`, `meetings`, `external_meetings`, `slack_msgs`, `sessions`, `docs`, `notes_mentions`, `last_at`.
  - It is filled by the projection (`run.ts` after `projectWeek`) from the rows' **top-3 candidates**, not only the chosen WhatId. A contribution counts at 1.0 for the logged opp and at its score for alternates ≥ 0.5.
  - This answers "attribute time to one opp, deserve DCs on several" without splitting hours.
  - Backfill: one re-projection (bump `PROJECTIONS_VERSION`).
- **Rule.** Deterministic, it replaces `dcGapOf` reasons. Suggest a DC on an open opp with amount > `missedOppMinAmountUsd`, no DC of mine, and no live request, when any of these holds:
  - (a) I'm on the team;
  - (b) engagement this quarter ≥ 1 h app hours, or ≥ 2 external meetings;
  - (c) the opp's AE is in `coveredAes` and the toggle is on;
  - (d) the sweep claims it.
  - The product filter becomes persona/team-pack config (`dcProducts`), not the D360 regex in `classify.ts`.
- **Default split.** 100% when no other architect DC is on the opp (the read already exists, sweep step 3). When there is one, a "split conversation" reason and no default.
- **Daily batch.** At 06:45 after the book read, Home and the review surface show "Claim N DCs". Each row has its evidence line, and all rows are pre-ticked except those with a split question. One click adds N `deal_contribution_requests`, which ride the next canvas as today. Set-aside reuses D-61 decisions.
- **Covered AEs (R7).**
  - Settings ▸ Deals: `deals.coveredAes: { enabled: boolean, aes: [{ name, org62UserId, since }] }` (settings JSON, no migration).
  - Adding a name runs one fixed `SELECT Id, Name, Email FROM User WHERE IsActive = true AND Name LIKE …` and you pick the hit.
  - Job `deals.covered_aes` (daily, 06:52) runs:
    - `SELECT OpportunityId, Opportunity.Name, Opportunity.AccountId, Opportunity.Account.Name, Opportunity.StageName, Opportunity.CloseDate, Opportunity.Amount, UserId, TeamMemberRole FROM OpportunityTeamMember WHERE UserId IN (…) AND Opportunity.IsClosed = false`;
    - plus `Opportunity WHERE OwnerId IN (…) AND IsClosed = false` (the AE is usually the owner).
  - Results are stored as opps with `ext.via = 'covered_ae'` and `opportunity_team_members` rows for the AE (non-me rows the table already supports).
  - Those AEs' opps also join the attribution candidates (signal "Covered AE <name>'s deal", 0.3). That is how a new deal of a covered AE gets matched on the first meeting.
  - The AE persona: hidden. Not *Config over code*-sensitive, because the list is per user.

### 4c. Use cases: capture, dedupe, one table (R6)

- **`use_case_candidates` (new table, additive).** Columns:
  - `id, owner_user_id, account_id, opportunity_id null, title, details, track d360|agentforce|null, source_refs jsonb, confidence, state new|accepted|dismissed|merged, matched_use_case_id null, dedupe_key, created_at`.
  - Fed by: (1) the `activity.notes` Haiku call, extended to return `{note, useCases: [{title, current, desired, product}], oppHint}` in the same call (no extra spend); (2) the Slack/Gmail scanners' existing `cc_propose_item` path with a new `use_case` kind (lane scanners); (3) Org62/VDP-only records the round trip already finds.
- **Dedupe.** Deterministic `sameUseCaseTitle` (`src/engines/vdp/gaps.ts`) against `use_cases`, `org62_use_cases`, staged VDP items and other candidates on the account. A near-duplicate is attached to the existing use case as "more evidence", not made new.
- **One table.** It replaces the "Use cases" scatter. Row: title, account, target opp (ranked by R1 over the account's open opps), state pills Org62/VDP, and the one action **Add to VDP + Org62**. That action stages the VDP `create_use_case` Outbox item and the `Use_Case__c` canvas row together (D-67/D-70 mechanics unchanged: two writes, one click, both through the Outbox).
- **When the opp is unclear, show the rundown.** One card with the account's open opps: stage, close, amount, my DC or team or covered AE, last meeting, engagement hours. Click an opp to set the target. No typing.
- **Model vs deterministic.** Extraction is Haiku (folded into the existing notes call). Dedupe, target ranking and staging are deterministic.

### 4d. One weekly review surface, "almost no thought" (R8)

- **The page.** `/activity` opens on **Review**: one scroll, checkboxes only.
  - **Hours.** Rows grouped by opp. Each row has its top suggestion as a chip, two alternates on hover, internal as an option. Rows ≥ 0.75 are pre-ticked; the rest show their one question in words.
  - **Internal.** Pre-ticked by type.
  - **DCs to claim** (R5).
  - **Use cases to add** (R6).
  - **Fixes.** Not in Org62, differs.
- **The button.** "Approve N, claim M DCs, add K use cases → stage canvas". Then the existing Apply and Slackbot hop, once a week.
- **Typing.** Only when the app says why ("no opp found in the app or Org62 for globex.example: search or mark internal").
- **Tabs.** Ledger, Weeks and VDP ▸ My VDPs stay as secondary tabs. Log it and Needs you merge into Review (one count).
- **Tenets kept.**
  - Pre-ticked is not sent: Apply on the canvas is still the human approval (*Nothing leaves without approval*). D-71's "never applied for you" holds, because a row is approved only when you press the button.
  - Hours stay human hours: engagement never adds hours.
- **Alternate surface.** Coordinate with lane UI. The Assistant can stage the same batch (`chat_log_batch`).

### 4e. Deterministic vs model

| Part | Deterministic | Model |
|---|---|---|
| Blocks, hours, overlaps, internal by type | ✓ (unchanged) | – |
| Candidate ranking, learned rules, live Org62 discovery queries | ✓ | – |
| Close calls (margin < 0.15, top < 0.75) | – | Haiku, 1 call per row, cached (D-71) |
| Notes → Description + use-case mentions + opp hint | – | Haiku, 1 call per notes doc (existing D-66 call, wider output) |
| DC suggestion rule, default split, covered-AE scan | ✓ | – |
| Use-case dedupe, target opp, staging | ✓ | – |
| Org62 fixed SOQL execution | ✓ query text | today a Haiku agent makes the call (`runOneReadLookup`); lane cost may make it a direct MCP call |

### 4f. Data additions and migration path

| Addition | Kind | Path |
|---|---|---|
| `mapping_rules` writes and reads | existing table (0001) | no migration; Settings list plus Remove |
| `opp_engagement` | new table | additive migration; filled by one re-projection (`PROJECTIONS_VERSION` bump) |
| `use_case_candidates` | new table | additive; empty at start, filled going forward plus one 30-day notes backfill under the daily cap |
| `suggestion_outcomes` (or `llm_decisions` rows) | new table, optional | additive |
| `opportunities` ext `via: book\|discovered\|covered_ae` | ext JSON | none; absent = book |
| `opportunity_team_members` non-me rows | existing table | none |
| settings `deals.coveredAes`, persona/team-pack `dcProducts`, classifier keywords | settings / team pack | defaults keep today's behavior (D360 tokens, current keywords) |
| `ActivityEntry.suggestions[]` (top 3) alongside `suggestion` | contract | additive; `suggestion` = `suggestions[0]` for one release |
| Typed `issues: {code, params}` alongside the string `flags` | contract plus column | dual-write one release, then readers move (R10) |

## 5. The short rule set (2 minutes)

These replace the D-59..D-72 prose as the readable spec. The decisions keep their history. All the owner's stated requirements fit inside these rules.

1. **Your hours are what you did.** An accepted meeting always logs. Solo work is the time between your own actions and never double-counts a meeting. Agent time never logs. (D-17, D-18)
2. **Every row gets a ranked guess with reasons.** Rules first, then Org62 when nothing fits, then a cheap model only for close calls. Internal is one of the choices. (D-64, D-71)
3. **Your corrections become rules.** Each one is listed and removable. A rule never overrides something you set. (*Suggest, then learn*)
4. **Nothing goes out until you press Apply.** Rows, DCs and use cases ride one canvas per batch. Slackbot executes it, and the app reads Org62 back. (D-47, D-67, D-72)
5. **A row on a waiting canvas is held.** Reject frees it. Apply hands it off. A change since staging drops it from the canvas. (D-47, D-65 preflight, D-68 DC-05)
6. **The link wins, then the key, then the closest match.** Org62 id, then `CC#`, then subject and time. (D-65, D-67)
7. **External wins, then flag.** A value someone changed in Org62 or VDP is adopted or shown side by side for you to pick. It is never overwritten or deleted. (D-65, D-67, D-68, D-70)
8. **Nothing stays stuck.** Every waiting or failed state has its next click: Log again, Leave out, Ask again, Not needed. (D-61, D-65, D-68)
9. **A DC is suggested where you did the work or cover the AE.** One click claims a batch. Org62's read settles it. (D-61, D-68, new)
10. **A use case lives in both systems.** The app captures candidates, dedupes them against both, and adds to VDP and Org62 in one click. (D-67, D-70, D-72)

Most of what reads as complexity in D-65..D-69 (twins, slot rule, timezone shift, duplicates, merges) is rules 6–8 applied to cases. It belongs in `docs/EDGE-CASES.md`, which already says so in its Principles 1–6, not in the decision table.

## 6. Org62 reads: what runs, how often, what's missing

| Read | Query (abridged) | Cadence | Where |
|---|---|---|---|
| `org62:opps` | OTM `UserId = me` (window) · Opportunity `AccountId IN (≤200 app accounts)` · `OwnerId = me` | 30 min work hours (×6 off hours, quiet backoff to ×8, capped) | `skills/scan-org62.md:45-57`, `cadence.ts:17,49` |
| `org62:events` | Event `OwnerId = me AND IsChild = false` (window, 40/page) | 60 min | `:62` |
| `org62:dcs` | Deal_Contribution__c `SE_Name__c = me` (window) | 60 min | `:68` |
| `org62:book` | OTM me open · Opp owned open · my DCs on open opps | once a day | `:130-140` |
| `org62:missed_opps` | Event hours by WhatId 180 d → D360 lines/names → lines and all DCs | daily | `:153-178` |
| `org62.readback` | Event/DC by Id (25/40 per batch) · Use_Case__c by opp (20/query) | daily 06:40 plus on-demand rechecks | `src/jobs/handlers/org62-readback.ts` |
| `vdp.specialist_aes` | SpecialistForecast__c on 100%-DC opps | daily 06:50 plus after Org62 read | `src/server/vdp/specialist-aes.ts` |
| `accounts.hierarchy` | Account Id, Name, ParentId (5 levels) | daily 06:55 | D-69 |
| Picker search / pick | Opportunity `Name/Account.Name LIKE` open · by Id | on demand | `src/server/chat/org62.ts:84-108` |

- **What attribution misses.**
  - **OTM for other users** (covered AEs; who else is on a deal).
  - **OpportunityContactRole and Contact** (attendee email → opp: the strongest new-deal signal).
  - **Account.Website** (domain → account without seeding aliases).
  - **Opportunities owned by covered AEs.**
  - **Recent activity history** on an opp: Events and Tasks by others, `LastActivityDate`. That signals a deal is live, and who the SE is.
  - **OpportunityLineItem** outside the sweep. The pipeline uses Amount only; see B-111.
  - Account hierarchy is already read (D-69). Reuse it so a child account's meeting can rank the parent's opps.
- **Allowlist constraints.**
  - Scanners and lookups may call only `soqlQuery` (`src/llm/mcp-config.ts:33-34`).
  - Write-like tool names are refused at config build (`:46-54`).
  - Builders run `assertReadOnlySoql` (`src/engines/deals/soql.ts`).
  - `runOneReadLookup` refuses any tool not on the scan allowlist (`src/server/onboarding/identity.ts:146`).
  - Every proposal above is a fixed SELECT through that path. Nothing widens the allowlist (*Read-only ingest*; CLAUDE.md invariant 2).
  - Output cap: keep the ≤ 50-row pages and 15/18-char Id batching rules (ORG-1).

## 7. Granola and meeting transcripts: the seam only

- **Today.** Transcript-like input enters as `gemini_notes` source items. The fetcher is `src/connectors/google/gemini-notes.ts`; it parses Summary, Decisions and Next steps.
- **Who reads them today:**
  - `scan-gemini-notes` (to-dos, Haiku);
  - `activity.notes` (the Description, Haiku).
- **Where Granola plugs in.** A Granola connector would emit the same normalized `meeting_notes` source item, keyed to the calendar event. Then R6's extraction, the D-66 note and next-step to-dos pick it up unchanged.
- **The one seam to keep stable.** That is the notes side-car the projection reads (`cc.ext/meeting_notes/<id>`, `logSummary`). Make its shape `{source: gemini|granola, eventId, sections}` when R6 lands.

## 8. Decisions for Tristan

- **D-T1: may a use case go to Org62 before your 100% DC?**
  - Today, D-63/D-67 scope it to open opps with my 100% DC, so new deals wait weeks.
  - Option A: keep it.
  - Option B: allow any open opp where I'm on the team, have engagement, or cover the AE. The DC suggestion rides along in the same batch.
  - **Recommend B.** Org62's `Use_Case__c` doesn't need a DC, and the owner wants it "seamless". VDP scope (D-63) can stay at 100% DC.
- **D-T2: covered-AE DC suggestions: all their open opps, or only where I have evidence?**
  - The owner asked for "suggest I claim DCs" on those AEs' deals.
  - The SE persona rule `dc_strong_evidence` says "claim only with strong evidence" (`src/personas/se.ts:41`). That conflicts with suggesting every covered-AE deal. It is a persona rule, not a tenet, but it is the owner's own stated rule.
  - **Recommend:** list all covered-AE opps above the amount threshold. Pre-tick only those with evidence. Show the rest unticked, labeled "no work yet".
- **D-T3: pre-ticked rows in the weekly review.**
  - D-71 says "never applied for you". Pre-ticking ≥ 0.75 rows still needs your one button and the canvas Apply, so no tenet is touched.
  - **Recommend** pre-tick. Confirm it reads as consistent with D-71.
- **D-T4: hours across several opps.**
  - Org62 Events have one WhatId. Splitting hours across opps would double-count or invent time (*Hours are human hours*).
  - **Recommend:** one WhatId per row, multi-opp only as DC evidence (`opp_engagement`).
- **D-T5: live Org62 discovery spend.**
  - About $0.01–0.03 per lookup today through a Haiku-driven call.
  - **Recommend** at most 20 per day, cached 7 days. Coordinate with lane cost (a direct MCP call would make it near-free).

## 9. What's fine, don't touch

- **The round-trip machinery.** Link → CC# → heuristics matching, external-wins, preflight registry (`src/lib/canvas/preflight.ts`), holds, `not_created` and `Log again`. The 97 edge cases are all OK with named tests.
- **`record_landings` / `landing_writes`** (D-70): the right generic shape. DC suggestions and use-case candidates should become new `record_kind` values, not new landing tables.
- **The hours engine.** Engaged time, accepted-meeting rule, no caps, onsite days (`src/engines/activity/blocks.ts`, `engaged.ts`, `onsite.ts`).
- **The cost pattern.** Rules, then Haiku with an input-hash kv cache, a per-pass cap and the daily hard cap (`activity-suggest.ts`, `activity-notes.ts`).
- **Fixed-SOQL lookups.** Through `runOneReadLookup` with kv caches (`vdp-specialist-aes.ts`, `account-hierarchy.ts`): reuse it for R3 and R7.
- **D-66 Description notes, dismiss-by-source rules (D-64), and `pickOrg62Opp`** (adds the opp and account in one undoable change set).

## 10. Open questions and what I couldn't verify

- **Click counts.** §2.4 is derived from code and copy, not timed in a live session. The real Needs-you volume on Postgres is unknown; the sample data is synthetic.
- **Real Slack attribution.** Whether real Slack bursts are as unmapped as the sample (48/48) is untested. It depends on how many channel names contain account names.
- **Org62 field access.** Whether `Account.Website`, `OpportunityContactRole` and `User` (non-me) are readable through the work Org62 MCP with the user's profile is not verified. The Assistant's allowlist includes them (`src/llm/chat/soql.ts:22`), which suggests yes.
- **AE ownership.** Whether covered AEs are reliably the Opportunity `OwnerId` or only OTM members needs one live read.
- **Non-me team rows.** The sample's non-me `opportunity_team_members` rows (83) have no writer in current code that I found. Possibly an older path or a generator artifact.
- **Calibration.** Haiku's self-reported confidence is not checked against outcomes anywhere, so I could not judge whether 0.75 is a good settle line.
