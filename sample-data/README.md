# Command Center sample dataset

A synthetic copy of the Command Center Postgres database: 120 tables, about 16.7k rows, one fictional user. It exists so that a person or an LLM can learn the shape of every table, how tables join, and the daily scenarios the app handles, without any real data.

## 1. What this is, and the privacy guarantee

- **Everything is invented.** People, companies, deals, messages, documents and numbers were written for this dataset. The owner is a fictional Solutions Engineer (Rafael Okonkwo) at an unnamed software vendor ("the vendor").
- **Markers you can rely on:**
  - External ids carry `SMPL`: Org62/Salesforce ids (`006SMPL00000007AAA`), Slack users/channels/DMs (`U0SMPL...`, `C0SMPL004`), Gmail/Drive/Calendar ids contain `smpl`.
  - Emails use `@example.com`, `@example.org` or `@<invented>.example`; URLs use `example.com` or `<invented>.example`; phone numbers use `555-01xx`.
  - Company names are invented or conventional placeholders. No credentials or tokens of any shape; connector `config` holds placeholders only.
- `npm run sample:lint` enforces these rules over `tables/*.json` and must stay clean.

## 2. How it relates to the app

Command Center is a locally run personal-ops cockpit for sellers. Connectors read (never write) Slack, Gmail, Calendar, Drive, Gemini notes, Org62, VDP and local Claude sessions into `source_items`. Engines turn items into `work_items` (the to-do list) with evidence, prioritise them (`priority_*`), propose next best actions, and draft replies, VDP updates and Org62 activity logs in the Outbox (`drafts`). Nothing leaves without approval: the user approves a draft, an adapter sends or stages it, and a read-back verifies it landed. Every change goes through a `change_set` and leaves `audit_events`. A worker runs scheduled `jobs`, scans and LLM calls under a daily budget. See `docs/ARCHITECTURE.md` and `docs/TENETS.md` in the repo root.

## 3. How to load it

Use a scratch Postgres database whose name contains `sample`. The loader refuses any other name and empties the tables it loads.

```
createdb control_center_sample
DATABASE_URL=postgres://localhost:5432/control_center_sample npm run db:migrate
npm run sample:load     -- --db control_center_sample      # loads every tables/*.json (FKs not enforced while loading)
npm run sample:validate -- --db control_center_sample      # proves every foreign key resolves
npm run sample:lint     -- --lines                         # privacy lint over the JSON
npm run sample:build                                       # regenerate tables/ from generators (runs 01..06, then the post-passes 90, 91 and 92)
```

Or just read the JSON: `tables/<table>.json` is an array of rows with DB column names, timestamps as ISO strings (UTC), jsonb as plain JSON, one row per line.

### Folder layout (`sample-data/`)

| Path | Purpose |
|---|---|
| `tables/` | The dataset: 120 JSON files, one per table. Generated; do not hand-edit. |
| `generators/01-core.ts` .. `06-intel-chat.ts` | One generator per domain (core, sources, ops, work, outbox-time, intel-chat), run in order. A later domain may read earlier domains' JSON. |
| `generators/90-reconcile.ts`, `91-consistency.ts`, `92-realism.ts` | Post-passes for facts that exist only once every domain has run: connector error stamps (90), cross-domain causality (91), and the realism pass (92: logged/manual time entries, VDP drafts and read-backs, health-check failure streaks, hook scan runs, calendar ledger rows, appended Org62 snapshots, enum coverage). |
| `generators/data/` | Hand-written content modules (Slack text, email bodies, notes, config). |
| `reservations/*.json` | Rows an earlier domain asks a later domain to create with an exact id (`ref()`/`reservedFor()`). |
| `lib/kit.ts` | Helpers: `uid`, `at`, `day`, `NOW`, `rng`, `sfId`, `slackUser`, `writeTable`, `readTable`. |
| `build-all.ts` | `npm run sample:build` entry point. |
| `BRIEF.md` | Rules and mechanics given to the generators (privacy rules, verification steps). |
| `WORLD.md` | Shared facts: domain order, fixed id ranges, volume targets, the 20 storylines. |
| `CAST.md` | Core story bible: people, accounts, opportunities, config, storyline assignments. |
| `CAST-sources.md`, `CAST-ops.md`, `CAST-work.md`, `CAST-outbox.md`, `CAST-intel.md` | Per-domain keys: every source item, job, work item, draft, brief with its story. **Start here to find the row for a scenario.** |

Scripts live in `scripts/sample-data/` (`load.ts`, `validate.ts`, `lint.ts`).

## 4. Time anchor and id conventions

- **"Now" is Wed 2026-11-18 09:00 MST (16:00 UTC)**, fiscal FY27 Q4 (Nov to Jan). History runs 2026-10-19 to now (the app has scanned for about 30 days; older material is sparser, and some scan ledgers reach back to September for backfills). Calendar events extend to 2026-11-25. Timezone of the owner: America/Denver; working hours 07:30 to 17:30 on weekdays. No row should be dated after now except calendar events, due dates and planned work.
- **Primary keys** are deterministic UUIDv5-style values from `uid('<table>', '<key>')` (sha1 of `cc-sample|table|key`). The CAST docs give the `<key>` (for example `wi-003`, `si-643`, `rev-elderglen-demo-reply`, `cs-12`); compute the UUID with `lib/kit.ts` or `grep` for the key in generator sources. A few tables use `bigint` ids instead (`jobs` 1..500, `llm_calls` 1..700, `connector_auth_events`).
- **Fixed ranges:** `scan_runs` n=1..160 (low n = oldest), `jobs` 1..500, `llm_calls` 1..700, `change_sets` n=1..500, `source_items` keys `si-001..`, `work_items` keys `wi-001..`.
- **External ids:** `sfId('006', n)` for Org62, `slackUser(n)`, `slackChannel(n)`, `slackDm(n)` for Slack. The owner is `uid('users','owner')` / Slack `slackUser(1)`.

## 5. Table map (120 tables)

Row counts are computed from `tables/*.json`. Every table has at least one row. `owner_user_id` is on nearly every table and always the one user, so it is left out of the key columns.

### Identity, org and config (01-core)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `users` | 1 | The one app user (the owner); timezone, team pack, role template, manager. | person_id, team_pack_id, role_template_id |
| `people` | 47 | Everyone the app knows: colleagues, customer contacts, partners; `tier`, `affiliation`, `merged_into_person_id` (identity merges). | account_id, merged_into_person_id |
| `person_identities` | 125 | One row per (person, system, external id): slack, gmail, org62, google handles. | person_id; (system, external_id) |
| `accounts` | 14 | Customer/prospect companies, with parent/subsidiary family; `is_my_book`, `is_watched`. | parent_account_id, family |
| `account_aliases` | 90 | Alternate names, domains, title tokens, channel patterns used to map text to an account. | account_id, kind, normalized_value |
| `opportunities` | 50 | Org62 opportunities, open and closed; `on_my_team`, stage, amount, close date. | account_id, latest_snapshot_id |
| `opportunity_team_members` | 106 | Who is on each opp team (AE, SE, specialist...); `is_me`, `removed_at`. | opportunity_id, person_id |
| `team_packs` | 1 | Versioned team configuration bundle (raw JSON) the role templates and rules come from. | slug, version |
| `role_templates` | 3 | Persona presets (e.g. SE individual contributor) that seed priority policy and agent preferences. | team_pack_id, key |
| `se_task_types` | 28 | Org62 task types and how they count (customer related/facing, bucket, swap targets). | team_pack_id, name |
| `fiscal_periods` | 6 | Fiscal quarters with logging deadlines and hour targets. | team_pack_id |
| `org62_picklist_values` | 33 | Allowed values of Org62 picklists (meeting type, stage, DC role, use-case stage). | team_pack_id, field, value |
| `channels` | 22 | Slack channels the owner can see; `watch_mode` (items, digest, ignore), customer-channel flag. | external_id |
| `connectors` | 9 | The 9 read connectors (slack, gmail, drive, calendar, gemini_notes, org62, claude, vdp); status and last error. | kind |
| `user_settings` | 28 | Key/value store (jsonb): `settings.*`, `onboarding`, `cc.*`, `readin/...`; PK is (owner, key). | key |
| `repos` | 6 | Local git repos the Claude-session scanner knows, with default account. | default_account_id |
| `org62_use_cases` | 10 | Mirror of Org62 use-case records. | org62_opportunity_id, vdp_use_case_id |
| `org62_use_case_reads` | 1 | Log of one full use-case read (when, counts, complete flag). | read_at |
| `use_cases` | 10 | App-side use cases joining the VDP use case to the Org62 one. | vdp_use_case_id, org62_use_case_id, opportunity_id |
| `specialist_forecasts` | 3 | Specialist forecast-comment rows (the only specialist view an SE gets). | opportunity_id, org62_id |
| `user_interests` | 12 | Declared interests (keywords, accounts) feeding relevance in briefs. | kind, value |
| `channel_account_maps` | 13 | Learned/ruled mapping of channel to account/opp, with method, confidence, user verdict. | channel_id, account_id, mapping_rule_id |
| `mapping_rules` | 32 | Pattern rules (domains, title tokens, meeting names) that map items to accounts/opps/task types. | kind, pattern, hit_count |
| `task_capture_rules` | 7 | Rules deciding which source text becomes work (promises, asks, training, travel). | rule_key |
| `team_rules` | 7 | Team cadence rules (weekly log Friday, quarter deadline, VDP review). | team_pack_id, key |
| `vdp_server` | 1 | Single row: when the VDP server was last read and its info. | read_at |
| `autonomy_policies` | 10 | Per action type autonomy level (L0_suggest ... L3_one_click) and optional target. | action_type, level |
| `voice_profiles` | 3 | Versions of the owner's writing voice used for drafts. | version, status |
| `priority_policies` | 3 | Versioned priority weights (v1 role template, v2 chat, v3 user). | version, based_on_policy_id |
| `priority_policy_rules` | 13 | Rules inside a policy (SLA, lane floor, never-above, exclude). | policy_id, rule_key |

### Sources and context (02-sources)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `source_items` | 939 | Every ingested thing: Slack message, email, calendar event, Drive revision, Gemini note, Org62 snapshot, VDP snapshot, Claude session. Body, meta jsonb, dedupe key. | connector_id, source, kind, dedupe_key |
| `source_item_refs` | 600 | Extracted references (urls, Org62 ids, VDP slugs, mentions) per item. | source_item_id, kind, value |
| `source_item_links` | 1802 | Item to account/opp/person/asset/event links with method, confidence, user verdict. | source_item_id + target ids, mapping_rule_id |
| `calendar_events` | 138 | Calendar events (past and to 2026-11-25), type, response, mapped account/opp. | source_item_id, external_event_id |
| `calendar_event_attendees` | 569 | Attendees per event with response, external flag, person link. | calendar_event_id, person_id |
| `meeting_notes` | 32 | Gemini notes matched to calendar events; parsed next-step counts. | calendar_event_id, source_item_id |
| `assets` | 121 | Tracked Drive files (and a few non-Drive assets), tiers, ownership, last modifier. | external_id, system, kind |
| `asset_snapshots` | 36 | Point-in-time reads of an asset (hash, section count). | asset_id, source_item_id |
| `asset_snapshot_sections` | 199 | Per-section text and hashes of a snapshot. | snapshot_id, section_key |
| `asset_snapshot_diffs` | 31 | Section-level diff between two snapshots. | asset_id, from/to_snapshot_id |
| `opportunity_snapshots` | 49 | Org62 opp field snapshots over time; `:latest` rows back `opportunities.latest_snapshot_id`. | opportunity_id |
| `vdp_records` | 12 | Mirror of the owner's VDP records: counts, missing items, detail jsonb. | vdp_slug, opportunity_id |
| `vdp_asset_candidates` | 59 | Assets suggested for a VDP with why/confidence and status (suggested/added/dismissed). | vdp_slug, target_key |
| `org62_events` | 45 | Mirror of Solutions Events in Org62 (what the owner has logged), one deleted upstream. | opportunity_id, source_item_id |

### Operations and audit (03-ops)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `jobs` | 500 | The worker queue: kind, queue, payload, status, attempts, errors (ids 1..500). | kind, status |
| `job_schedules` | 10 | Recurring job definitions (interval/cron, catch-up, pause reason). | key, connector_id |
| `worker_instances` | 8 | Worker process heartbeats (host, pid, app version). | last_beat_at |
| `scan_runs` | 160 | One scan of one connector scope: trigger, mode, status, counts, cost, error. | connector_id, job_id |
| `scan_run_events` | 1423 | Ordered trace events of a run (plan, coverage, spend, link...). | run_id, seq |
| `scan_ledger_entries` | 1711 | What time range/page each run covered and the outcome. | scan_run_id, scope |
| `scan_cursors` | 24 | Per-scope scan cursor and watermarks. | connector_id, scope |
| `connector_health_checks` | 709 | Periodic probe results per connector. | connector_id, checked_at |
| `connector_auth_events` | 39 | Auth lifecycle events (expired, reauth requested, refreshed). | connector_id, reauth_attempt_id |
| `reauth_attempts` | 10 | Re-authentication attempts and outcome. | connector_id, job_id |
| `app_events` | 132 | User-visible operational events (warn/error/info) with fingerprint and occurrence count. | scan_run_id, job_id, entity_* |
| `notifications` | 18 | Bell items (budget alerts, blocked work) with an action. | app_event_id, job_id |
| `llm_budgets` | 1 | Daily USD limits (soft/hard) and effective dates. | scope |
| `llm_budget_days` | 31 | Per-day reserved/spent USD against a budget. | budget_id, day |
| `llm_calls` | 700 | Every model call: purpose, model, tokens, cost, status, error. | job_id, scan_run_id, chat_message_id |
| `llm_call_days` | 36 | Daily roll-up of llm_calls (older days). | day, purpose, model |
| `llm_decisions` | 29 | Why the app chose a model or blocked (escalate, hard cap). | llm_call_id, skill_key |
| `llm_decision_days` | 7 | Daily roll-up of llm_decisions. | day, skill_key |
| `change_sets` | 500 | One row per user/engine/connector/chat/system change; groups audit rows; undoable (ids 1..500). | actor_kind, entity_type/id |
| `audit_events` | 1220 | Row-level before/after for every write; `changed_fields`, `coalesced_count`. | change_set_id, table_name, row_id |
| `content_revisions` | 10 | Revision history of edited documents (draft bodies), autosave bursts. | entity_type, entity_id, field |

### Work and priorities (04-work)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `work_items` | 107 | The to-do list: kind, origin, status, due, lane, account/opp, closure and resolution. | account_id, opportunity_id, parent_id, initiative_id |
| `work_item_evidence` | 401 | Source items that created, progressed or completed an item, with role and verdict. | work_item_id, source_item_id |
| `work_item_transitions` | 233 | Status history with actor and reason. | work_item_id, change_set_id |
| `work_item_relations` | 47 | Item to item relations (parent, duplicate, blocks). | from/to_work_item_id |
| `work_item_links` | 191 | Item to person/asset/event/repo/Claude session links. | work_item_id |
| `work_item_deliverables` | 14 | The file a work item is expected to deliver, with judgment status. | work_item_id, asset_id |
| `work_item_training_details` | 2 | Training item details (course, mandatory, progress). | work_item_id |
| `work_item_travel_details` | 1 | Travel item details (trip, approval, booking, expense). | work_item_id |
| `deliverable_requirements` | 33 | Required sections/points of a deliverable with status. | deliverable_id |
| `deliverable_judgments` | 16 | LLM verdicts on whether a snapshot meets requirements. | deliverable_id, diff_id, snapshot_id |
| `extractors` | 22 | Versioned extractors (rules, parsers, models) that produce candidates. | key, version |
| `extraction_candidates` | 103 | Proposed work items found in a source item, with decision. | source_item_id, extractor_id |
| `change_proposals` | 13 | Proposed field changes awaiting user decision (close, move due date). | entity_type, entity_id, evidence_id |
| `reopen_decisions` | 8 | What happened when a late reply hit a closed item (reopened, sibling, context, ignored). | done_work_item_id, trigger_source_item_id |
| `initiatives` | 12 | Groupings of related work (a customer deliverable, an event). | account_id, opportunity_id |
| `initiative_links` | 100 | Members of an initiative (people, assets, sessions, channels). | initiative_id |
| `priority_runs` | 25 | Each run of the prioritizer with policy and capacity. | policy_id |
| `priority_plan_steps` | 15 | Today's plan around calendar gaps. | run_id, work_item_id |
| `priority_scores` | 283 | Per run, per work item score components and lane. | run_id, work_item_id |
| `priority_score_rule_hits` | 311 | Which policy rules fired for a score. | score_id, rule_id |
| `next_best_actions` | 67 | Versioned suggested next step per work item (draft reply, log activity, run tool). | work_item_id, draft_id, supersedes_id |

### Outbox, time and logging (05-outbox-time)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `drafts` | 141 | Everything the app proposes to send/write: Slack, email, VDP, Org62 batch, canvas; status lifecycle, `doc_json`. | work_item_id, nba_id |
| `draft_recipients` | 107 | To/cc/channel targets of a draft. | draft_id, person_id |
| `draft_renditions` | 186 | Rendered bodies (plain, html, markdown) per doc version. | draft_id |
| `draft_send_attempts` | 98 | Each send attempt (dry run, failure, retry) via an adapter and job. | draft_id, job_id |
| `draft_verifications` | 80 | Read-back that a write really landed. | draft_id, send_attempt_id |
| `activity_entries` | 182 | Proposed/logged Org62 activity rows (time logging): status machine, task type, duration. | opportunity_id, org62_event_row_id |
| `activity_entry_time_blocks` | 73 | Minutes of each time block allocated to an entry. | activity_entry_id, time_block_id |
| `time_blocks` | 246 | Engaged-time blocks from calendar, doc edits, Slack bursts, Claude work, travel. | calendar_event_id, claude_session_segment_id |
| `canvases` | 4 | Slack canvases the app may write (logging, work order, review). | external_id |
| `canvas_sync_runs` | 14 | Each write/read-back of a canvas. | canvas_id, draft_id |
| `canvas_lines` | 32 | Lines rendered into a canvas (entries, DC requests) with checkbox marks. | sync_run_id, activity_entry_id, dc_request_id |
| `record_landings` | 170 | Remote record state per write target (VDP/Org62): present, differs, missing. | record_id, destination |
| `landing_writes` | 140 | Field-level writes planned/sent against a landing with before/after. | landing_id, draft_id |
| `deal_contributions` | 5 | Deal contribution rows seen in Org62. | opportunity_id, contributor_person_id |
| `deal_contribution_requests` | 3 | Requests to add/change my DC (role, split) and their status. | deal_contribution_id, missed_opp_finding_id |
| `missed_opp_sweeps` | 8 | Runs of the missed-opportunity sweep. | scan_run_id |
| `missed_opp_findings` | 9 | Opps the owner worked on without a DC, by tier, with verdict. | opportunity_id, sweep ids |
| `claude_sessions` | 31 | Local Claude sessions: repo, branch, status, waiting state. | repo_id, connector_id |
| `claude_session_segments` | 36 | Active/human/background milliseconds per segment, mapped to account/opp. | claude_session_id |
| `tool_adapters` | 8 | Registered tools the app can launch (demo builders etc.). | key |
| `tool_runs` | 8 | Runs of those tools for a work item/NBA. | adapter_id, work_item_id, nba_id |
| `tool_run_outputs` | 7 | Outputs (links, assets) a tool run produced. | tool_run_id, asset_id |

### Intel and chat (06-intel-chat)

| Table | Rows | What it holds | Key columns / joins |
|---|---:|---|---|
| `watch_subscriptions` | 6 | What the owner follows (account, opp, person, channel, search) and brief cadence. | account_id, opportunity_id |
| `briefs` | 10 | Generated briefs per period. | subscription_id |
| `brief_highlights` | 26 | Items inside a brief with level and status (new, seen, promoted, dismissed). | brief_id, promoted_work_item_id |
| `brief_highlight_reasons` | 46 | Why a highlight ranked (interest, rule, account). | highlight_id, policy_rule_id |
| `brief_scan_runs` | 42 | Scan runs a brief covers. | brief_id, scan_run_id |
| `relevance_feedback` | 22 | User reactions to highlights (opened, useful, dismissed). | highlight_id, change_set_id |
| `relevance_weights` | 20 | Learned weight per feature key from feedback. | feature_key |
| `chat_threads` | 8 | Assistant conversations (global, account, work item, day). | work_item_id, account_id |
| `chat_messages` | 56 | Messages with `content_blocks` (text, tool parts). | thread_id, seq, llm_call_id |
| `chat_tool_calls` | 34 | Tool calls made in a message; mutations carry a change set. | message_id, change_set_id |
| `provenance_links` | 150 | Why something exists: source item to NBA/draft/entry/finding/brief. | source_item_id + target id |
| `reconcile_findings` | 44 | Gaps the reconciler found (missed items, coverage gaps, duplicates). | connector_id, source_item_id, work_item_id |

Total: 16660 rows in 120 tables. `work_item_degradations` (a view) and `__drizzle_migrations` are not included.

## 6. The 20 storylines and where to follow them

Keys below are `uid('<table>', '<key>')` arguments. Details and sibling rows are in the CAST docs named in the last column.

| # | Storyline | Follow it through | CAST |
|---|---|---|---|
| 1 | Hot deal (Saltmere POC) | account `saltmere`; opp `saltmere-data360-poc` ($1.25M, Technical Validation, close 12-12); work item `wi-003` blueprint due Fri 11-20 with sub-items `wi-005/015/039/099`, asks `wi-006`, `wi-018`; deliverable on asset `hv-blueprint` (+ `deliverable_requirements`, `deliverable_judgments`); draft `rev-saltmere-blueprint-email`; VDP record slug `saltmere-health-plan-data-360-poc` (`vdp_records.missing_items`); Tue/Thu "Saltmere weekly sync" in `calendar_events` and `meeting_notes`; channel `saltmere-poc`; source item `si-608` | CAST, CAST-work, CAST-sources |
| 2 | Expansion demo (Elderglen Outdoors) | opp `elderglen-outdoors-renewal-expansion`; ask `si-643` (+ chasers `si-664`, `si-705`); work items `wi-031` (reply), `wi-032` (demo), `wi-105` (sandbox); NBA `wi-031:v1/v2`; unapproved Slack draft `rev-elderglen-demo-reply` (status `ready`) with `content_revisions` | CAST-work, CAST-outbox |
| 3 | Gone quiet (Halvergate) | opp `halvergate-route-exceptions-agent` (close date passed); `wi-008`, `wi-042`, `wi-044`; drafts `wi008-nudge-1/3`, `wi042-nudge-recap`; items `si-114`, `si-250`, `si-415`, `si-561`; watch `opp-halvergate` (paused) and brief `halvergate-1113` | CAST-work, CAST-intel |
| 4 | Account family | parents `yarrowdale`, `elderglen`; subs `yarrowdale-mg`, `yarrowdale-bh`, `elderglen-outdoors`, `elderglen-home`; `accounts.parent_account_id`, `account_aliases`, `mapping_rules` `dom-*`, change set 74 (the correction); VDP identity item `si-530`; `user_settings` key `cc.org62.account_hierarchy` | CAST, CAST-sources |
| 5 | Missed opportunity | opp `harrowgate-maintenance-agent` (`on_my_team` false); evidence `si-158, 421, 422, 424`, sessions `cs-01`, `cs-02`; `missed_opp_findings` tier `strong_evidence_no_dc`; `deal_contribution_requests` (role AI + Data Architect); `wi-049`; activity entry `dc-harrowgate-maintenance-agent`; logging canvas | CAST-outbox, CAST-work |
| 6 | Training and travel | account `cascadia`; onsite 11-23/24 (channel `cascadia-onsite`); `wi-021` + `work_item_training_details` (due 11-21, calendar hold `training-hold`); `wi-051` + `work_item_travel_details`; `wi-052`, `wi-053`, `wi-059`; items `si-688`, `si-692` | CAST-work, CAST-sources |
| 7 | Time logging | `activity_entries` (statuses proposed, verified, logged, needs_input (Ferrowpay, two matching opps), one deleted in Org62: `act-o62-22`); the 11-13 canvas batch `act-o62-32..43,45`, draft `cv-dc-1114`; `activity_entry_time_blocks` to `time_blocks`; `org62_events`; weekly items `wi-085..090` | CAST-outbox, CAST-work |
| 8 | Pipeline failures | connector `slack` degraded (429 since 08:41 today); `vdp` reauth (`connector_auth_events`, `reauth_attempts`); Drive auth error 4 days ago; budget hard cap 2026-11-10 (`llm_budget_days.blocked_at`, `app_events.code=budget_hard_cap`, `notifications`, budget-blocked `llm_calls`); 6 dead `jobs`; 31 failed `scan_runs` (mostly transient) | CAST-ops |
| 9 | Auto-close then reopen | Oakhallow order-form items: `work_items` "Technical sign-off on the Oakhallow order form addendum" (reopened, `last_reopened_at`), `reopen_decisions` (trigger = Valentina's late reply `si-695`); ask `si-653`, redline `si-658` | CAST-work, CAST-sources |
| 10 | Identity mess | person `hv-mari-dup` merged into `hv-marisol` (`merged_into_person_id`, two Slack `person_identities`); mapping rule `sender-mari-q`; chat thread about it; `ext-tobias` (no account), items `si-348`, `si-373`, `si-570` | CAST, CAST-intel |
| 11 | Claude sessions | repos `saltmere-poc-demo`, `ferrowpay-fraud-agent`; sessions `cs-01..cs-31` (e.g. `cs-12` app-launched blueprint draft, `cs-08` waiting_on_me); `claude_session_segments` to `time_blocks.claude_session_segment_id` (`claude_hands_on` = engaged time); `tool_runs`, `tool_run_outputs` | CAST-outbox |
| 12 | Meeting to work | `meeting_notes` for Saltmere weekly sync and Yarrowdale architecture review, then `extraction_candidates`, `change_proposals`, new `work_items` with `work_item_evidence` role `origin` | CAST-work, CAST-sources |
| 13 | Priorities | active policy `v3` (rules `r_customer`, `r_manager`, `r_admin`, `r_mgr_sla`, `r_blueprint_floor`, `r_training_cap`, `r_noise_exclude`); newest `priority_runs`, `priority_scores` + `priority_score_rule_hits`, `priority_plan_steps`; Top 3: Saltmere blueprint, Elderglen reply, Oakhallow order form | CAST-work |
| 14 | Briefs and watches | `watch_subscriptions` `acct-voltmere`, `acct-contoso`, `q-prior-auth`; briefs `weekly-voltmere-1118` etc.; `brief_highlights` (must_read / worth_a_look / fyi) with `brief_highlight_reasons`; `relevance_feedback` and `relevance_weights` | CAST-intel |
| 15 | Chat | threads `due-week` ("What is due this week"), `blueprint`, `logging`, `first-week`; `chat_messages` (`llm-chat-01..14`), `chat_tool_calls`; read-in under `user_settings` key `readin/work_item/<id>` | CAST-intel |
| 16 | VDP assets | `vdp_asset_candidates` for `saltmere-health-plan-data-360-poc` and `ferrowpay-financial-fraud-agent` (status in_vdp, suggested, added, unsure, dismissed); few recordings; `vdp_records`, `use_cases`, `org62_use_cases` | CAST-sources |
| 17 | Drafts lifecycle | verified `rev-saltmere-blueprint-email`; failed-then-retried `s-pc-owner` (`draft_send_attempts` not_in_channel then ok); `v-pc-golive` verify_failed; `s-gustavo-numbers` unconfirmed; rejected, superseded (`wi008-nudge-1`), discarded; `draft_renditions`, `draft_verifications` | CAST-outbox |
| 18 | Noise | channels `company-announcements`, `industry-news` (ignore), `contoso-marketplace` (digest); ignored senders via mapping rules `ign-*`; newsletter `source_items` (e.g. "Partner Digest"); dismissed highlights | CAST |
| 19 | Org62 events | `org62_events` (one with `deleted_upstream_at`), `org62_picklist_values`, `se_task_types`; linked from `activity_entries.org62_event_row_id` | CAST-sources |
| 20 | Specialist view | three `specialist_forecasts` rows (saltmere, yarrowdale-enterprise-data, ferrowpay-data360-foundation); no second persona | CAST |

## 7. How to read the data

- **Pipeline direction:** `connectors` -> `scan_runs` (with `scan_run_events`, `scan_ledger_entries`) -> `source_items` (+ refs, links) -> `extraction_candidates` / `work_item_evidence` -> `work_items` -> `priority_scores` -> `next_best_actions` -> `drafts` -> `draft_send_attempts` -> `draft_verifications` / `record_landings`. `provenance_links` answers "why does this exist".
- **Changes and audit:** every write the app makes carries a `change_sets` row (actor kind: user, engine, connector, chat, system, autonomy_policy); `audit_events` holds before/after per row and `changed_fields`; `work_item_transitions` and `content_revisions` point back to change sets; undo is a change set with `undo_of_change_set_id`.
- **Where time logging lands:** engaged time becomes `time_blocks` (calendar, doc edits, Slack bursts, Claude hands-on) -> `activity_entry_time_blocks` -> `activity_entries` (status: proposed -> approved -> synced_to_canvas -> logged -> verified) -> a logging canvas (`canvases`, `canvas_lines`) or direct write -> `org62_events` (the read-back mirror) and `landing_writes`.
- **Multi-account family rollups:** `accounts.parent_account_id` + `family`; opportunities and work items reference the subsidiary.
- **Status words matter:** work items `suggested` (engine guess) vs `open`; `waiting_on_me` vs `waiting_on_others`; `likely_done` (engine thinks done, user not confirmed) vs `done`; drafts `ready` (waiting for the user) vs `verified` (sent and read back).
- **jsonb columns** follow the app's real shapes (`audit_events.before/after` are full rows, `source_items.meta` is per connector, `chat_messages.content_blocks` are typed parts, `user_settings.value` varies by key).

## 8. Known simplifications

- **Volumes are scaled down** (about a month of history, 14 accounts, 50 opportunities, 107 work items, 99 drafts) and several enum values the app can produce appear only once or never.
- **Sparse tables** (under 10 rows): `users` 1, `team_packs` 1, `vdp_server` 1, `llm_budgets` 1, `org62_use_case_reads` 1, `canvases` 4, `deal_contribution_requests` 3, `specialist_forecasts` 3, `work_item_training_details` 2, `work_item_travel_details` 1, `tool_runs` 8, `tool_run_outputs` 7, `reopen_decisions` 8, `content_revisions` 10.
- **Happier than real life:** health checks are 94% healthy, drafts mostly verified, scan runs mostly scheduled; the real system sees more failures and hook-triggered scans. Roll-up tables (`llm_call_days`, `llm_decision_days`) are single-model and uniform.
- Seeded timestamps (`created_at` of accounts, opportunities, aliases, extractors) share one instant; they are not event times.
- `work_item_degradations` (a view) and `__drizzle_migrations` are not part of the dataset. No attachments or binary bodies exist; document text is short.
- Generators encode some local-looking fictional paths (`claude_sessions.cwd`); they point nowhere real.
