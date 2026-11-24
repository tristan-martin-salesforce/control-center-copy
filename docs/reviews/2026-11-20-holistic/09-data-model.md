# 09: Data model and long-term extensibility (lane DM)

Reviewer: data-model lane, 2026-11-20. Read-only, except one scratchpad spike (outside the repo) that applied every migration to PGlite. I made no Postgres connection; the db-mode claims below come from reading the code unless I say otherwise.

## 1. Summary

1. **The schema is good. Three things around it make it hard to extend.**
   - The db DataSource loads a user's *whole* contract-shaped world into memory on every request (`src/server/datasource/db/model.ts:1-8,217-260`).
   - Fields the contract has and the schema doesn't go to a jsonb kv side-car, `user_settings` `cc.ext/<table>/<id>` (`src/server/datasource/db/ext.ts:1-14`). The 2026-11-13 audit counted 3,819 such rows in the real DB.
   - A second, in-memory DataSource (`mock/`, 7.7k lines) re-implements the same 143 methods (`types.ts`) against contract shapes.

   So the real model is the API contract, and Postgres stores it; the 120-table schema is partly bypassed. **Business state is in the kv side-car:** `dcAssigned`, `dcStatus`, `nextStep`, need decisions, canvas picks. SQL joins it by string-built keys (`deals-sync.ts:75,199,258`, `projections/run.ts:316`, `jobs/handlers/brief.ts:105,131`).
2. **Deal Contribution truth sits in three places:** `deal_contributions.is_mine`, `cc.ext/opportunities.dcAssigned` and `cc.ext/accounts.dcStatus`. A sync job keeps them aligned (`deals-sync.ts:60-80`). Five engines then derive "DC gaps" from them, which is why the same gap shows differently in Deals, Home and the account page.
3. **Org62 and VDP mirrors are bespoke per object, with three ingest paths.**
   - Ingest:
     - scanner → `source_items` snapshot → projection;
     - `org62.readback` → `org62_use_cases` directly;
     - `forecast.sync` → `specialist_forecasts` directly.
   - Every mirror table re-invents `first_seen/last_seen/gone`.
   - The 15/18-character Org62 id is normalized by hand **199 times in 28 files**.
   - VDP use cases, assets and owners are only jsonb inside `vdp_records.detail`.

   D-70's landing + write log is sound and should be **the** outbound pattern. Inbound needs one mirror convention, not a generic `external_records` table: `source_items` already is that table.
4. **RAG would not move the $10/day.**
   - About 70% of model dollars are agentic connector scans (`scan_extract`). Retrieval over the local DB doesn't touch them.
   - The two DB-retrieval paths are already capped and rule-based: the completion check at ≤14k chars per batch (`scanner/completion/pass.ts:76-81`), and the settle check, which uses ranked FTS (`engines/settle/load-db.ts:217`).
   - The Assistant's local source search is probably broken. It filters on `source_items.excerpt`, which doesn't exist, and swallows the error into `[]` (`db/chat-be6.ts:297-317`), so every lookup falls through to live MCP calls. Fix lexical search first. Add local-model embeddings (pgvector) only for entity resolution and Assistant semantic search.
5. **Storage: bundle real Postgres 17 (embedded binaries, app-managed) for teammates. Use PGlite in-process for mock mode and the DB test suites.**
   - My spike: all 26 migrations (872 statements in `0001_init`, all triggers, exclusion constraints, `NOTIFY`) apply on PGlite 0.3.4 / PG 17.4 in 1.6 s, and trigger `pg_notify` reaches `listen()`.
   - PGlite is single-connection, so web + worker + `claude -p` tool servers can't share it safely as production storage.
   - SQLite would mean rewriting 232 raw-SQL call sites, plus the audit/undo triggers, `NOTIFY`, exclusion constraints and `range_agg`.

## 2. How it works today (pointers for the next builder)

**Layers.**
- `src/db/schema/*.ts`: 25 domain files plus `columns.ts`, 120 tables plus 1 view (`work_item_degradations`).
- `src/db/schema/enums.ts`: 139 `pgEnum`s.
- Migrations: `src/db/migrations` (26 files, numbers 0018/0019/0021 skipped, journal idx contiguous), applied by `src/db/migrate.ts` and checked by `migration-state.ts`. The worker refuses to claim jobs unless the schema is `match` (`src/worker/schema-guard.ts`).
- Writes go through `withChangeSet` (`src/db/changeset.ts`). The plpgsql `cc_audit` trigger records before/after for 48 audited tables and raises without a change set; universal Undo replays those images (`0002_extras.sql:23-183`, `0005_audit_row_key.sql`).
- Live updates come from `pg_notify('cc_change')` in the audit trigger plus the 0026 triggers on bookkeeping and mirror tables (`0026_live_notify.sql`). They are consumed by a `LISTEN` client in the web process (`src/server/datasource/db/events.ts:155-166`).

**Reads.**
- `loadModel()` loads ~27 contract collections for the user: people, accounts, opps, work items, evidence, drafts, NBAs, events, time blocks, activity, chat, etc. It loads them in contract shape, plus every `cc.%` kv row, and pages compose from memory (`model.ts:217-260`).
- Only `jobs` and `scanRuns` are opt-out (`model.ts:200-209`, PERF-1).
- SQL-shaped reads (Q1-Q16) live in `src/db/queries.ts` and `db/views.ts`.

**Projections** (`src/projections/run.ts`, `PROJECTIONS_VERSION = 10`, `:102`) run every minute in the worker. They read `source_items` past a watermark (`cc.projections`) and upsert accounts, opps, team members, Org62 Events, DCs, calendar events, assets, sessions, meeting notes, time blocks and activity entries. A version bump means a full re-projection; its history is the comment block at `run.ts:73-101`.

**Two DataSources.**
- `src/server/datasource/mock` (7,681 lines; `index.ts` 4,166) is the in-memory implementation over `src/mock/seed.example.json`.
- `src/server/datasource/db` (19,842 lines; `index.ts` 4,779) is the Postgres one.
- They share pure engines (87 common imports), e.g. `src/lib/landings/sync.ts`.
- Parity is checked by `tests/be1b` (26 files, ~190 tests), which need Postgres. `npm run test` excludes them (`vitest.config.ts:15`).

**Sizes** (`sample-data/tables`, synthetic but realistic in shape). The hot tables are:

| table | rows |
|---|---:|
| `source_item_links` | 1,802 |
| `scan_ledger_entries` | 1,711 |
| `scan_run_events` | 1,423 |
| `audit_events` | 1,220 (the largest by bytes, 1.9 MB) |
| `source_items` | 939 |
| `connector_health_checks` | 709 |
| `llm_calls` | 700 |
| `jobs` / `change_sets` | 500 each (capped by the generator) |

The real DB was 255 MB after one week (audit lane E4).

## 3. Findings

### 3.1 The model as built: entity map

| Domain | Canonical tables | Derived / projection | kv side-car (`cc.*` in `user_settings`) | JSONB holding business state | Writers |
|---|---|---|---|---|---|
| Sources / ingest | `source_items` (raw log, all 8 sources, incl. Org62 and VDP record snapshots), `source_item_refs`, `source_item_links`, `extractors`, `extraction_candidates`, `connectors`, `scan_cursors` | `calendar_events`, `meeting_notes`, `assets`, `asset_snapshots*`, `claude_sessions*` | `cc.ext/calendar_events` (agenda, takeaways), `cc.ext/meeting_notes` (next steps, use case), `cc.projections` (watermark) | `source_items.meta` (Org62 record fields live here: `StageName`, `Amount`…) | scanner (`cc_*` tools), projections |
| Work | `work_items`, `work_item_evidence`, `work_item_transitions`, `work_item_relations`, `work_item_links`, `initiatives*`, `change_proposals`, `reopen_decisions` | `priority_runs/scores/rule_hits/plan_steps`, `next_best_actions`, `work_item_degradations` (view) | `cc.ext/work_items` (startByUser, enrichment state), `cc.ext/work_item_evidence` (isNew), `cc.ext/change_proposals` (labels), `cc.ext/initiatives` (timeline), `cc.need/*` (needs-you decisions), `cc.plan.slots` | `work_items.closure_params` | web (user), engines (closure, reeval, settle), chat |
| Time / activity | `time_blocks`, `activity_entries`, `activity_entry_time_blocks`, `canvases*`, `deal_contribution_requests` | activity rows are re-derived by projections stage B | `cc.ext/activity_entries` (logNote, sources, accountName), `cc.ext/time_blocks`, `cc.time.suggestions`, `cc.time.dismiss-rules`, `cc.onsite.overrides`, `canvas.row_overrides` (your picks) | none | projections, web |
| Deals / Org62 mirror | `accounts`, `account_aliases`, `opportunities`, `opportunity_snapshots`, `opportunity_team_members`, `org62_events`, `deal_contributions`, `org62_use_cases`, `org62_use_case_reads`, `specialist_forecasts`, `missed_opp_*` | `opportunities.latest_snapshot_id` | `cc.ext/opportunities` (**dcAssigned, nextStep, products, ownerId, hoursQtd, leftBookAt**), `cc.ext/accounts` (**dcStatus**, org62Url), `cc.deals/dc-read`, `cc.org62.account_hierarchy` | `opportunity_snapshots.extra` | projections (scanner path), `org62.readback` job, `forecast.sync` job |
| VDP mirror | `vdp_records`, `vdp_asset_candidates`, `vdp_server`, `use_cases` (app identity, D-70) | the count columns on `vdp_records` | `cc.vdp.identity`, `cc.vdp.identity.judgments`, `cc.vdp.push`, `cc.vdp.autopilot`, `cc.vdp.specialist_aes` | **`vdp_records.detail`**: use cases, assets, AEs/TAs/collaborators, stakeholders (`entities.ts:393`) | `scan.vdp`, `vdp.push` |
| Outbox / audit / landings | `drafts`, `draft_recipients`, `draft_renditions`, `draft_send_attempts`, `draft_verifications`, `record_landings`, `landing_writes`, `change_sets`, `audit_events`, `content_revisions`, `provenance_links` | landings are re-synced on every read (`lib/landings/sync.ts`) | `cc.ext/drafts`, `cc.ext/change_sets` (seeded display) | `drafts.payload`/`doc_json`, `record_landings.remote_values`, `landing_writes.before/after` | web Apply, worker delivery, read-backs |
| LLM / jobs / scans | `llm_calls`, `llm_decisions`, `llm_budgets*`, `jobs`, `job_schedules`, `worker_instances`, `scan_runs`, `scan_run_events`, `scan_ledger_entries`, `reconcile_findings`, `tool_*` | `llm_call_days`, `llm_decision_days` (rollups) | `cc.spend`, `cc.ext/app_runs`, `cc.ext/connectors`, `cc.ext/tool_runs` | `jobs.payload/result` | worker |
| Settings / kv | `user_settings` (PK owner+key), `autonomy_policies`, `priority_policies*`, `role_templates`, `team_packs`, `voice_profiles`, `user_interests`, `channels`, `mapping_rules` | none | **41 distinct `cc.*` keys in code**, plus `cc.ext/<table>/<id>` for 20+ tables | `user_settings.value` | everyone |

**DM-1 (major): the kv side-car holds business state and is joined by string-concatenated keys.**
- Evidence:
  - `ext.ts:1-14` says the side-car exists "for contract fields the schema has no column for yet" and was raised "as a blocker so BE-0 can add real columns". That never happened.
  - Writers: `store/entities.ts:122,172,268,343`, `store/projections.ts:105,175,288,392,480,755`, `store/time.ts:254,283,349`, `store/work.ts:560,657,807,883,1026`, `store/nba.ts:386,423`, `store/briefs.ts:122,225,265`, `store/health.ts:156`.
  - SQL joins on `s.key = 'cc.ext/opportunities/' || o.id::text and (s.value->>'dcAssigned')::boolean` (`deals-sync.ts:75`; also `:199,:258`, `projections/run.ts:316,842,1398`, `jobs/handlers/brief.ts:105,131`, `log-batch.ts:158`).
  - The hygiene sweep has to garbage-collect orphans with `to_regclass(split_part(key,'/',2))` (`hygiene/sweep.ts:379-399`).
- Why it matters:
  - These fields can't be indexed, constrained or FK'd, and don't cascade when their row goes.
  - Every request loads all of them (`loadKv`, `ext.ts:46-54`).
  - A teammate's agent can't discover them from the schema, and any new column has to be added in three places: table, ext, contract.
  - It cuts against *tenet: Legible* for builders.

**DM-2 (major): the db DataSource is a re-hosted mock.**
- Evidence:
  - `model.ts:3-8` states the assumption: "a single-user, local database of a few thousand rows, so a request loads the user's collections once and composes from memory".
  - `loadModel` reads all work items with no status or date filter (`store/work.ts:211`), all evidence, drafts, NBAs, events and time blocks (`model.ts:240-260`).
  - Two vocabularies: 139 pg enums vs ~301 `z.enum`s in `src/contract`, bridged by `db/enums.ts` (511 lines). Where the db enum is coarser, the contract value is kept as a "qualified override" in the side-car (`db/enums.ts:1-8`).
- Why it matters:
  - Page latency and memory grow with history: closed items, past events and time blocks are kept forever.
  - Every feature is written twice (mock + db), plus a translation layer.
  - The owner's "extensible" goal pays this tax on every change, and the parity tests that catch drift don't run in `npm run test`.

**DM-3 (major): mock vs db duplication.**
- 143 DataSource methods (`types.ts`), each implemented in `mock/index.ts` (4,166 lines) and `db/index.ts` (4,779 lines).
- The mock exists because dev, review lanes and unit tests have no Postgres. PGlite removes that reason (§3.4, DM-14).

**DM-4 (minor): doc drift.**
- `docs/ui/DATA-MODEL.md:73-95` lists 108 tables; the code has 120.
- `docs/ui/DB-NOTES.md` lists 24 schema files and migrations up to 0003.
- `docs/ARCHITECTURE.md` still says SQLite (the brief notes this).
- `DATA-MODEL.md §1.7` says `source_items.meta` "must never hold message text". Org62 snapshots put record fields there, which is fine, but undocumented.

### 3.2 Org62 and VDP

**How Org62 is mirrored.**
- Scanner path:
  - The scanner (agentic `claude -p` with the Org62 MCP) writes `org62_record_snapshot` source items. In the sample: 155 Opportunity, 42 Account, 45 Event, 40 Use_Case__c, 8 OpportunityTeamMember and 3 Deal_Contribution__c snapshots.
  - Projections then upsert `accounts`, `opportunities` (+ `opportunity_snapshots`, with a `fields_hash` and `extra` jsonb), `opportunity_team_members`, `org62_events` and `deal_contributions`.
- `org62_use_cases` is written by the `org62.readback` job from its own SOQL, bypassing `source_items` (`store/use-cases.ts:1-10`). Its completeness lives in `org62_use_case_reads`.
- `specialist_forecasts` is written by `forecast.sync` directly (`server/forecast/store.ts:1-5`). It denormalizes opp name, account name, stage, next step and close date into its own columns (`schema/forecast.ts:32-34`).
- Read-back for the outbound side: `record_landings.remote_values` (D-70).

**How VDP is mirrored.**
- `scan.vdp` writes a `vdp_record_snapshot` source item and replaces the `vdp_records` row (`store/vdp.ts:1-15`).
- The whole normalized VDP sits in `detail` jsonb: company, AEs, TAs, collaborators, stakeholders, use cases (id, name, hasAi, goLive) and assets (`sample-data/tables/vdp_records.json`).
- Summary counts are columns: `use_case_count`, `asset_count`, `has_ae`, `missing_items`.
- `vdp_asset_candidates` holds app-side suggestions. `use_cases` (D-70) gives one app id per use case across VDP and Org62.

**How they join.**
- The VDP stores `salesforceOpportunityId(s)`, matched to `opportunities` by the 15-character prefix, then by account, then by company name (`engines/vdp/gaps.ts linkVdp`).
- `use_cases` carries both `vdp_use_case_id` and `org62_use_case_id`.
- The landings tie each record to its destinations.

**DM-5 (major): one use case has four representations.**
- `vdp_records.detail.useCases[]`, `org62_use_cases`, `source_items` Use_Case__c snapshots, and `use_cases` (the identity row).
- Each has its own "seen" logic, and the compared fields (name, product, stage, go-live) are re-extracted from jsonb on every landing sync (`docs/design/landings.md`, "Differences and picks").
- Why it matters: owner ask 6 ("use cases into Org62 + VDP seamlessly") runs through four shapes. A bug in any one shows as a false "differs".

**DM-6 (major): Org62 id normalization is hand-rolled everywhere.**
- `left(x, 15)` / `id15(` appear 199 times in 28 files outside migrations.
- No mirror column stores the canonical 18-char id or a generated 15-char key.
- Why it matters: every join between VDP, Org62, DCs and landings has to remember it. A missed one silently fails to link, which reads as "item not matched" (owner ask 2).

**DM-7 (major): mirror tables re-invent the same lifecycle with different names.**
- `gone_at` on `vdp_records`, `org62_use_cases` and `specialist_forecasts`; `deleted_upstream_at` on `org62_events`, `deal_contributions` and `source_items`; `removed_at` on `opportunity_team_members`; `archived_at` on `opportunities`.
- Read completeness lives in three places: `org62_use_case_reads`, `vdp_server`, and the kv key `cc.deals/dc-read`.
- Two mirrors (`org62_use_cases`, `specialist_forecasts`) keep no history, because they skip `source_items`.

**DM-8 (minor): VDP owners and assets are invisible to SQL.**
- AEs, TAs and collaborators exist only in `detail` jsonb, so "a VDP I'm on links it" (the DC-gap rule, `engines/deals/needs.ts:10`) is evaluated in TS after loading every VDP.
- VDP assets have no rows, so asset landings use synthetic ids (`vdpasset:<id>`, landings.md).

**Is D-70 sound? Yes, for outbound.**
- `record_landings` (record × destination, state, remote values) plus `landing_writes` (an immutable op log with before/after, linked to the carrying draft), with the field map in code (`src/lib/landings/fields.ts:1-5`), is the right size.
- A new destination is a new enum value, a field map and a transport: no table.
- It satisfies *tenet: Audit everything outbound* and *tenet: Provenance on everything*.

**DM-9 (minor): two outbound ledgers overlap.**
- `draft_send_attempts` + `draft_verifications` (the Slack/email Outbox) and `landing_writes` (Org62/VDP) both track sent → verified.
- Slack posts and Gmail drafts don't use landings. They should, so that every external write has one history (see R5).

**A generic `external_records` table? No.**
- `source_items` already *is* the generic versioned external log: `source`, `kind`, `external_id`, `dedupe_key`, `content_hash`, `revision`, `meta` payload, `first/last_seen_at`, `deleted_upstream_at`.
- A second generic table would be a fifth copy.
- What's missing is a **convention**: every external object flows through `source_items`; a typed mirror table carries a standard column set and a declared field map; reads are logged in one place (R4).

### 3.3 Structured vs other models: search, RAG, facts

**Where text lives.**
- `source_items.body`: redacted at ingest, nulled after 90 days (D-7).
- `asset_snapshot_sections.text`, `meeting_notes` (via source items), `chat_messages.content_blocks`, `drafts.doc_json`.

**How it is searched.**
- Generated `search_tsv` plus GIN on `source_items` and `work_items` (`schema/sources.ts:90,108`; `schema/work.ts:154,180`).
- Trigram GIN on names (`opportunities_name_trgm_idx`, `entities.ts`).
- Users of FTS:
  - settle uses `websearch_to_tsquery` + `ts_rank` (`engines/settle/load-db.ts:217,323`);
  - read-ins (`db/readin.ts:455-461`);
  - work-item search (`db/index.ts:3875-3879`).
- No embeddings anywhere.

**DM-10 (major, likely bug): the Assistant's local source search probably always returns nothing in db mode.**
- `searchLedger` selects and filters `s.excerpt` from `source_items` (`db/chat-be6.ts:302,307`). That table has no `excerpt` column in any schema file or migration.
- The query is wrapped in `.catch(() => [])` (`:316`), so a SQL error becomes an empty result.
- `chat/host.ts:79` then relies on live connector lookups instead.
- No test covers it.
- Not verified at runtime: no Postgres here.
- Why it matters: this is exactly owner ask 4 ("hits limitations constantly", "more efficient than raw Claude"). Every "find that message" goes to an MCP round trip.

**Would RAG/embeddings reduce tokens?** Cost share from `sample-data/tables/llm_calls.json`, which is synthetic but shaped like the real audit table:

| Use | How context is built today | Size today | With retrieval (top-k chunks) | Verdict |
|---|---|---|---|---|
| Completion check ("did I later answer this ask?") | Deterministic candidates: same thread/DM/email thread, to the asker, same file/event (`scanner/completion/candidates.ts:1-15`), ≤6 per item, ≤14,000 chars (~3.5k tokens) of evidence per batch call (`pass.ts:76-81`) | ~3.5k evidence tokens per call; the fixed skill + system prompt dominate | Embeddings would add the "paraphrased delivery in another channel" case. They wouldn't shrink the pack: it is already top-k | **No.** Structural rules beat similarity here. Add a `same_account` semantic tie-break later |
| Settle (resolution, read more) | Thread + "elsewhere" FTS top-30, then a scored top-14, + 8 siblings, excerpts ≤1,000 chars (`settle/context.ts:11,184-212`) | ≤ ~40 excerpts ≈ 8-10k tokens worst case (estimate) | Top-8 chunks of ~150 tokens ≈ 1.2k tokens | **Maybe later.** About 6-8k tokens saved per worst-case call, ~$0.006 per call on Haiku-class pricing. Small, because settle is ~11% of spend (audit 2026-11-13) |
| Entity resolution ("which opp is this about") | Rules + trigram + aliases (`projections/matching.ts`, `account_aliases`, `mapping_rules`); `resolve_entity` calls are rare | Small | An embedding of opp name + account + products + next step vs the message: a good *candidate generator* for owner ask 6's "rundown of opportunities" | **Yes, the best fit.** Local, cheap, no LLM call needed for the shortlist |
| Assistant lookups | Pages up to 40k chars each (`server/chat/read.ts:127`); ledger search broken (DM-10); history up to 320k chars (`llm/chat/prompt.ts:87`) | 10k tokens per page read; several pages per turn | Hybrid FTS + vector over source items and work items returns 10 hits × 60 tokens instead of a page | **Yes, after DM-10.** The biggest token lever is returning hits, not pages |
| Use-case / next-step extraction | From meeting notes and Org62 next steps, per note (`jobs/handlers/activity-notes.ts`) | One note per call | Not a retrieval problem | **No** |
| Agentic scans (`scan_extract`, ~70% of $ in the sample) | `claude -p` traversing connectors via MCP | 100k+ input tokens per run plus cache reads | Local retrieval doesn't touch what the connector returns | **No.** This is the LLM lane's problem (precheck, cheaper model, cursors) |

**Recommendation.**
1. Fix lexical search first: DM-10, then `search_tsv` + `ts_rank` + trigram on titles for the Assistant (S).
2. Then add one `embeddings` table (owner, `subject_type`, `subject_id`, chunk, model, `vector(384)`, `content_hash`) with HNSW, filled by a worker job for source items (while their body exists), work items, opps and use cases.
3. Use it for (a) the opp shortlist, (b) Assistant semantic search, (c) completion tie-breaks.

**Caveats.**
- **Privacy:** API embeddings (OpenAI, Voyage) send message text off the machine. That conflicts with *tenet: Local data, privacy-safe logs* and with the Salesforce compliance note ("MCP connections and `claude -p` only"). **Blocker if proposed. Use a local model only**, e.g. bge-small or nomic-embed (384/768-dim) via transformers.js / ONNX in the worker: ~30-130 MB download, ~5-20 ms per chunk on Apple Silicon (my estimate, not measured).
- **Size:** 384-dim float32 is 1.5 KB per chunk, so 100k chunks ≈ 150 MB plus index.
- **Retention:** embeddings derived from a body must expire with the body (D-7). They are body-derived text in another form.
- **Engine:** pgvector works in Postgres and in PGlite. My spike built an HNSW index and ran a cosine kNN on PGlite 0.3.4's bundled `vector`. sqlite-vec exists for SQLite, but SQLite isn't recommended (§3.4).

**DM-11 (minor): facts and provenance are spread over five link tables.**
- `work_item_evidence` (401 rows: origin, progress and completion with verdict), `source_item_links` (1,802: item → entity with method and confidence), `provenance_links` (150), `work_item_links` (191), `initiative_links` (100).
- Closure reads evidence; Legible ("why is this here") reads all five (`getItemTrace`).
- **Recommendation:** no new facts table. Make `work_item_evidence` the closure fact table with explicit provenance columns: `extractor`/`skill` + version, `observed_at`, `llm_call_id`, the `gate` and the confidence already in its reason. Fold `provenance_links` into it where the target is a work item. It is already append-mostly with verdicts, the event-log shape you want. Mutable rows elsewhere (work items, activity) are fine because `audit_events` gives the history.

### 3.4 Storage engine for a packaged app

**What in `src/db` and the app is Postgres-specific** (counts exclude `migrations/meta`):
- plpgsql triggers: audit/undo, append-only guards, `cc_audit_kv`, `NOTIFY`. 25 `CREATE TRIGGER`s in 2 files: `0002_extras.sql` and `0026_live_notify.sql`.
- Exclusion constraints over `tstzrange` with `btree_gist`: `0002_extras.sql:8,14`, `0022`.
- Generated `tsvector` columns.
- `pg_trgm` GIN.
- `LISTEN`/`NOTIFY`: 24 hits in 9 files.
- `SKIP LOCKED` plus `pg_try_advisory_xact_lock` in the queue: 11 and 17 hits (`db/queue.ts`, DB-NOTES item 5).
- `range_agg` in ledger compaction (`retention-tables.ts`).
- jsonb operators: 160 `->>`.
- 203 `::timestamptz` casts.
- 232 raw `execute(sql…)` calls in 39 files.
- 139 `pgEnum`s.

**Drizzle.** Schemas are dialect-specific (`pg-core` vs `sqlite-core`); there is no single schema that targets both without a generator or duplicate definitions ([Drizzle schema docs](https://orm.drizzle.team/docs/sql-schema-declaration), [drizzle-kit config](https://orm.drizzle.team/docs/drizzle-config-file)). Drizzle has a PGlite driver ([Drizzle <> PGlite](https://orm.drizzle.team/docs/connect-pglite)).

**Spike (this review, scratchpad only).** PGlite 0.3.4 reports PostgreSQL 17.4. With `pg_trgm` and `btree_gist` loaded, it applied every journal migration 0000-0026, 121 relations and 69 triggers, in 1.6 s in-memory. A row insert fired `cc_live_notify` and the payload reached `db.listen('cc_change')`. Advisory locks, `FOR UPDATE SKIP LOCKED` and `range_agg` all ran. Not tested: the full suites, the Drizzle migrator on PGlite, file-backed `dataDir` persistence, and concurrency.

| Option | Teammate setup | Fit with today's code | Multi-process (web + worker + `claude -p` cc tools + CLI scripts) | pgvector | Risks |
|---|---|---|---|---|---|
| A. Keep Homebrew Postgres | `brew install postgresql@17`, `brew services`, `createdb` (`scripts/ops/setup.mjs:155-187`) | 100% | Yes | Via brew | Fails the owner's "no standing up a custom DB" |
| **B. Bundle real Postgres 17** (app-managed `initdb`/`pg_ctl` from [embedded-postgres](https://github.com/leinelissen/embedded-postgres), zonky-based per-platform npm binaries incl. darwin-arm64/x64; or a Postgres.app-style relocatable build; pgvector builds exist: [postgres-vector-embedded](https://github.com/boomship/postgres-vector-embedded), [allfuel/lpg](https://github.com/allfuel/lpg)) | Nothing: `npm run setup` or the packaged app initializes a cluster under `~/Library/Application Support/control-center/pg` on a private port (registered beside 4327) | 100%: same engine, same SQL, same migrations | Yes, it is a real server | Ship it with the binaries (check whether the zonky builds include contrib `pg_trgm`/`btree_gist`: **not verified**, spike first) | A lifecycle owner is needed (start, stop, crash recovery, upgrades between PG majors); ~30-60 MB download |
| C. PGlite as the app DB ([pglite.dev](https://pglite.dev/docs/api), [extensions](https://pglite.dev/extensions/)) | Nothing (WASM, npm) | ~95% (spike above) | **No.** It runs Postgres single-user mode, one connection ([v0.4 announcement](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)). [pglite-socket](https://pglite.dev/docs/pglite-socket) multiplexes connections over that one session, "not all cases might be covered", and interleaved transactions are the hard part | Bundled (`@electric-sql/pglite/vector`) | Web and worker would need one owning process plus a socket. Long worker transactions block the UI. Performance under a scan burst is unmeasured |
| D. SQLite (better-sqlite3 / libsql, FTS5, sqlite-vec) | Nothing | Rewrite: second schema, all 232 raw-SQL sites, audit/undo triggers rewritten without plpgsql, no NOTIFY (poll or IPC), no exclusion constraints, no `SKIP LOCKED` (fine with a single writer) | Yes (WAL, one writer) | [sqlite-vec](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md) | Weeks of work and a second dialect forever; violates *North star: Fast to ship* |
| E. Drizzle dialect abstraction (PG + SQLite) | Depends | Two schemas or a generator, plus raw SQL per dialect | n/a | n/a | Pays D's cost permanently to keep A's option. Not recommended |

**Recommendation: B for the app, plus PGlite for mock mode and tests.**
- Production stays on one Postgres dialect. Teammates never install a DB.
- `CC_DATA=mock` becomes the db DataSource on in-process PGlite, seeded from `seed.example.json` through the existing `seed-from-mock` path (`scripts/db/seed-from-mock.ts`, `db/from-mock.ts`). The web-only dev server is single-process, which PGlite handles.
- This deletes the mock DataSource over time (DM-3). It also lets `tests/be0`, `be1a` and `be1b` run without a server, in a fresh in-memory DB per file in ~2 s, which helps lane 10.

**Migration path for existing users (v1.x on brew PG17 → bundled PG17).** One `npm run update` step, behind a major version:
1. Back up as today (`pg_dump` → `backups/`).
2. `initdb` the bundled cluster (same major, 17, so a dump/restore is lossless).
3. `pg_restore` into it.
4. **Verify:** compare row counts per table and a `sum(hashtext(row::text))`-style digest for the audited tables between old and new. Refuse to switch on any mismatch.
5. Point `DATABASE_URL` at the bundled port in the env file.
6. Leave the brew database untouched for 14 days.
7. Doctor reports "old Homebrew database still present; remove with …".

A failure leaves the env file pointing at brew, which is the same rollback contract `update.mjs` already has (`scripts/ops/update.mjs:1-12`). Users who set `DATABASE_URL` themselves are left alone.

### 3.5 Retention and size

Existing horizons:
- `RETENTION_HORIZONS` (`src/jobs/handlers/retention-tables.ts:35-46`):
  - jobs: 30 days when done, 90 when dead, 400 when outbound;
  - ledger: compacted at 30 days;
  - `scan_runs`: 90 days;
  - health checks: 30 days;
  - `llm_*`: 400 days, then rolled up.
- `retention.ts`: bodies 90 days, scan trace 30 days, audit images and content revisions scrubbed at 90 days.

Gaps:

| Table | Today | Grows with | Proposed |
|---|---|---|---|
| `source_items` rows | body nulled at 90 d; row forever | every scan | Keep rows (dedupe needs them). Prune superseded `org62_record_snapshot` / `vdp_record_snapshot` rows older than 400 d that nothing references (keep the latest per `external_id`) |
| `audit_events`, `change_sets` | images scrubbed at 90 d; rows forever | every write (largest by bytes) | Delete after 400 d. Undo past 30 d is not offered anyway (verify the undo window in the UX lane) |
| `priority_runs/scores/rule_hits` | forever | every rerank × changed items | Keep 30 d plus each work item's current score |
| `next_best_actions` (superseded) | forever | every regenerate | 90 d after superseded |
| `draft_renditions` | forever | every edit | Latest per draft plus the sent one |
| `app_events` (resolved), `notifications` (read) | forever | ops noise | 90 d |
| `connector_auth_events`, `reauth_attempts` | forever | auth churn | 180 d |
| `scan_run_events` / ledger / runs / jobs / health / `llm_calls` | as above | | Keep as built |
| `landing_writes`, `record_landings`, `draft_send_attempts`, `draft_verifications` | forever | outbound only | Keep forever (*tenet: Audit everything outbound*); small |
| `cc.ext/*` kv | orphan sweep (`hygiene/sweep.ts:379`) | per row | Disappears with R1 |
| embeddings (future) | n/a | | Expire with the body they came from |

Add a `db:size` line to Doctor: the top 10 tables by `pg_total_relation_size`, so the next audit has real numbers.

### 3.6 Migrations

**Discipline today.**
- `drizzle-kit generate` (never `push`, `drizzle.config.ts:1-8`), with custom SQL for triggers.
- One transaction for all pending migrations (`migrate.ts:5-6`).
- `compareSchema` catches the case where drizzle silently skips an older-timestamped entry (`migration-state.ts:1-15`).
- The worker holds while the schema isn't `match`.
- `update.mjs` backs up, builds first, then migrates.
- Number gaps (0018/0019/0021) are cosmetic; the journal idx is contiguous.

**Data reshapes.** These ride on `PROJECTIONS_VERSION` bumps: a full re-projection from `source_items`, history at `projections/run.ts:73-101`. This is good: derived tables can be rebuilt. It only works while the raw item is still in `source_items`, so the two direct-write mirrors (DM-7) can't be rebuilt.

**DM-12 (minor): no recorded app ↔ schema compatibility.** The release version and the journal aren't tied together. A v1.2 → v2.0 jump replays every migration in one transaction. That's fine for additive DDL, but a backfill inside a migration (R1's kv → columns) could be slow on a 1 GB DB and holds locks while the app is stopped. **v1.2 → v2.0 path:** `npm run update` → backup → build → migrate (DDL only) → start the worker → backfill jobs run in batches with progress in Health. The old columns or kv keys are read as a fallback until the backfill reports done; they are dropped in the next minor.

**Rules for `CONTRIBUTING.md` (data section).**
1. **Additive first.** A minor release only adds tables, nullable columns, enum values and indexes. Renames and drops wait for the next minor after the code stopped reading them (expand → migrate → contract).
2. **No data moves inside DDL migrations.** A backfill is a registered job (idempotent, batched, resumable, reported in Health), or a `PROJECTIONS_VERSION` bump when the data is derivable from `source_items`.
3. **Destructive changes need a major** plus the backup-verified path in `update.mjs`.
4. **One migration per PR**, generated, with its snapshot. Custom SQL only for what Drizzle can't model, with a header comment saying why.
5. **No new `cc.ext/*` keys.** A field the contract needs gets a column (or a child table) in the same PR.
6. **Every external object** follows the mirror convention (R4).
7. **`schema_version` check:** keep the worker's `match` guard. Also make the web process show a blocking banner, not 500s, when the schema is behind. Unverified whether it does today.
8. **Retention is declared with the table:** a new log-like table names its horizon in `RETENTION_HORIZONS` or says "forever because …".

### 3.7 UI consolidation implied by the model (the UI-audit lane owns the UI)

- **DC gaps.** Deals ▸ Log & fix (`engines/deals/needs.ts`), Home `missed_dc` (`engines/home/build.ts:475-483`), the missed-opp findings tiers (`engines/deals/findings.ts:120-212`), VDP `no_dc_note` (`contract/vdp.ts:47`) and the account panel's `dcStatus`. Feed them all from one `dc_coverage` view per opp: my DC (from `deal_contributions` only), request in flight, hours this quarter, team membership, VDP link, finding tier, need decision.
- **"Needs you" rows.** They come from `cc.need/*` decisions over rules computed in four engines. Store decisions in a `need_decisions` table (rule, subject, kind, baseline) and serve one `needs` query per page.
- **Use case status.** VDP tab, Activity ▸ Use cases, landings. Feed them from one use-case view over `use_cases` + the landings, after R3.
- **Opp facts** (stage, next step, close date). `opportunities`, `opportunity_snapshots`, the `cc.ext/opportunities` `nextStep`, and the copy in `specialist_forecasts` disagree after a partial read. Make `opportunities` (current) the single read, and join forecasts to it.
- **Outbound status.** Outbox (drafts and attempts) vs Activity (landings). Show one "where did it land" timeline per record from `landing_writes`, after R5.

## 4. Recommendations (prioritized)

| # | What | Effort | Depends on | Migration / compat |
|---|---|---|---|---|
| R0 | **Fix DM-10**: the ledger search uses real columns (`body`, with the excerpt computed) and `search_tsv @@ websearch_to_tsquery`, ranked with `ts_rank`. Stop swallowing errors (log the code, return a note). Add a db test | S | Assistant lane | none |
| R1 | **Promote the kv side-car to columns.**<br>Columns on `opportunities`: `dc_assigned`, `next_step`, `products[]`, `owner_person_id`, `left_book_at`.<br>Columns on `accounts`: `dc_status`, `org62_url`.<br>Columns on `activity_entries`: `log_note`, `log_note_basis`, `sources jsonb`.<br>Columns on `calendar_events`: agenda and takeaways.<br>Columns on `meeting_notes`, `work_items` (`start_by_user`, `enrichment_status`).<br>New tables: `need_decisions`, `canvas_row_overrides`.<br>`dcAssigned` should be derived from `deal_contributions`, not stored (DM-1/DM-2) | L | Lane 11 (refactor) | Additive columns. A backfill job copies `cc.ext/<t>/<id>` into them; readers prefer the column and fall back to ext until the backfill reports done; ext keys are deleted in the next minor. The audit trigger already covers the columns (undo keeps working) |
| R2 | **Stop loading the world per request.** Each page reads what it shows (open items + a window). Keep `ReadModel` only for Today/Home, scoped to open work and a ±14-day calendar/time window | L | R1; UI lane (pagination of history) | No data change |
| R3 | **Org62 id hygiene and the use-case shape.**<br>A generated `org62_id15` column on every table holding an Org62 id (`opportunities`, `accounts`, `org62_*`, `deal_contributions`, `specialist_forecasts`, `vdp_records.salesforce_*`, `use_cases`), indexed. Replace the 199 hand-rolled joins.<br>Child tables `vdp_use_cases` and `vdp_assets` (and `vdp_members`: AE/TA/collaborator → `people`), projected from `vdp_records.detail`. `use_cases` is the identity. `detail` stays as the raw payload | M | none | Additive. Generated columns need no backfill; VDP child rows fill on the next `scan.vdp` or a re-projection |
| R4 | **One mirror convention for every external object (the inbound counterpart of D-70).**<br>Every read lands in `source_items` (kind `<system>_record_snapshot`) first. That includes the `org62.readback` use cases and `forecast.sync`, which gives them history and lets a re-projection rebuild them.<br>Typed mirror tables carry the standard columns `external_id`, `id15` (where Org62), `payload_hash`, `first_seen_at`, `last_seen_at`, `gone_at`, `source_item_id`.<br>A declared field map per (system, object) in `src/lib/mirror/<system>.ts`, next to `lib/landings/fields.ts`.<br>One `mirror_reads` table (system, object, scope, complete, `read_at`, counts) replaces `org62_use_case_reads`, `vdp_server.read_at` and `cc.deals/dc-read`.<br>Adding a connector then means: snapshot kind + field map + (optional) typed table | M | Connectors lane (ask 7) | Rename `deleted_upstream_at`/`removed_at` → `gone_at` by expand/contract over two minors |
| R5 | **Landings for every outbound write**: Slack posts, email drafts and the feedback post get `record_landings`/`landing_writes` rows (destination `slack`/`gmail`). `draft_send_attempts` stays as the transport log | M | Outbox lane | Additive; backfill sent drafts as `origin = 'backfill'` |
| R6 | **PGlite for mock mode and the DB test suites**: CC_DATA=mock → db DataSource on in-process PGlite seeded from `seed.example.json`. Run be0/be1a/be1b in `npm run test` (a fresh DB per file). Retire `mock/` method by method | M (switch), L (delete mock) | Lane 10 (testing); verify the Drizzle migrator and the be1b suite on PGlite | None for users; dev-only |
| R7 | **Bundled Postgres 17 for teammates**: app-managed cluster, private port, LaunchAgent or app-owned lifecycle, Doctor checks. The migration path is in §3.4 | M-L | Lane 12 (packaging) | Major release; dump → restore → verify → switch; brew DB kept 14 days |
| R8 | **Retention gaps** (§3.5) + Doctor `db:size` | S | none | Deletes only past horizons, never referenced rows (reuse the FK-catalog check in `retention-tables.ts`) |
| R9 | **Evidence as the fact table**: provenance columns on `work_item_evidence`, fold `provenance_links` for work-item targets, one `getItemTrace` query | M | Scanner/closure lane (ask 2) | Additive + backfill job |
| R10 | **Local embeddings** (pgvector, local model) for the opp shortlist and Assistant search, after R0 and R3 | M | LLM lane, R7/R6 (pgvector in both engines) | Additive table; filled by a job; expires with bodies |
| R11 | **Docs**: regenerate the DATA-MODEL §0 table list from the schema (a script), fix DB-NOTES and ARCHITECTURE (Postgres), add the CONTRIBUTING data rules (§3.6) | S | Lane 9 | none |

**Order:**
- R0, R8 and R11 now.
- Then R3 + R4 together, then R1. R1 is easier once mirrors have columns.
- R2 and R6 can run in parallel.
- R7 goes with packaging. R5, R9 and R10 come after.

## 5. Decisions for Tristan

1. **Storage engine.**
   - (a) Keep brew.
   - (b) Bundle Postgres 17. **Recommended.**
   - (c) PGlite as the app DB.
   - (d) SQLite.

   (b) changes no SQL and keeps undo, audit and live updates as built. (c) is attractive, but web + worker + tool servers would share one connection. (d) is a rewrite of the data layer. Whatever you pick, use PGlite for mock and tests (R6).
2. **Retire the mock DataSource** in favor of db-on-PGlite? **Recommended yes.** It removes ~7.7k lines and the drift class of bugs. The cost: mock-only scenario features (`CC_SCENARIO`, `CC_MOCK_NOW`) must be re-implemented as seed + clock on the db side, so check which are still used.
3. **kv side-car → columns in v2.0** (R1). **Recommended yes.** It is the one migration that touches most of the store code, and it fits "this review will touch most code". The alternative: freeze it (no new keys) and migrate opportunistically.
4. **Embeddings.** **Recommended:** defer until R0 and R3 land, then local-model only. API embeddings are a **blocker** under *tenet: Local data, privacy-safe logs* and the Salesforce compliance constraint. They need your explicit call if anyone proposes them.

## 6. What's fine, don't touch

- **The schema core.** Owner-scoped keys, `pgEnum` for engine state machines, lookup tables for team-pack vocabularies, bigserial logs, timestamptz + `local_day` (DATA-MODEL §0 "Conventions").
- **Write-path guarantees.** `withChangeSet` + the `cc_audit` trigger + universal Undo + `change_proposals` for locked fields (`db/changeset.ts`, DB-NOTES). This is the best part of the system: keep it in any engine choice.
- **The job queue:** leases, `SKIP LOCKED` + advisory dedupe, dead-letter (`db/queue.ts`).
- **The D-70 landings model** and its field map (`lib/landings/fields.ts`), and the use-case identity table (`use_cases`).
- **Projections as rebuildable derivations** with `PROJECTIONS_VERSION`.
- **Migration safety:** `migration-state.ts`, the schema guard, and `update.mjs` ordering (backup, build, migrate, rollback).
- **The 90-day body expiry and the audit scrub** (D-7), and the `llm_*` rollups.

## 7. Open questions / not verified

- **DM-10 is static evidence only.** No Postgres here. Confirm with `npm run test:be1b` or a one-line db test.
- **The real DB's current size** and the `cc.ext` row count today; the numbers above are from the 2026-11-13 audit.
- **PGlite gaps:**
  - not run: the be1b suite or the Drizzle migrator (`drizzle-orm/pglite/migrator`) on it;
  - file-backed `dataDir` durability and performance not measured;
  - the pglite-socket multiplexer not tested with web + worker.
- **Bundled Postgres extensions:** whether the zonky/embedded-postgres binaries ship contrib (`pg_trgm`, `btree_gist`) and pgvector. Spike: `select * from pg_available_extensions`.
- **Token numbers:** the per-skill tokens come from synthetic `sample-data/tables/llm_calls.json`. The settle context-size estimate is from the caps in code, not measured prompts. The LLM lane should measure with real `llm_calls`, which now record cache tokens.
- **The web process with the schema behind:** I didn't check whether it shows a clear banner or fails per request.

Sources:
- [PGlite Socket](https://pglite.dev/docs/pglite-socket)
- [PGlite v0.4 announcement](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)
- [PGlite extensions](https://pglite.dev/extensions/)
- [PGlite API (listen)](https://pglite.dev/docs/api)
- [PGlite filesystems](https://pglite.dev/docs/filesystems)
- [Drizzle <> PGlite](https://orm.drizzle.team/docs/connect-pglite)
- [Drizzle schema declaration](https://orm.drizzle.team/docs/sql-schema-declaration)
- [drizzle-kit config](https://orm.drizzle.team/docs/drizzle-config-file)
- [embedded-postgres](https://github.com/leinelissen/embedded-postgres)
- [@embedded-postgres/darwin-arm64](https://socket.dev/npm/package/@embedded-postgres/darwin-arm64)
- [postgres-vector-embedded](https://github.com/boomship/postgres-vector-embedded)
- [allfuel/lpg](https://github.com/allfuel/lpg)
- [sqlite-vec README](https://raw.githubusercontent.com/asg017/sqlite-vec/main/README.md)
