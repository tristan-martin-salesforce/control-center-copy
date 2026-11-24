# BE-1b: the Postgres DataSource and its parity suite

`CC_DATA=db` serves every `/api/v1` route from Postgres (`src/server/datasource/db/**`). This suite loads the
same seed into the mock and into Postgres and checks that both answer every DataSource method the same way.

```bash
npm run test:db:datasource # (alias: test:be1b) drops + recreates control_center_be1b_main (per-checkout name), migrates, runs tests/db/datasource
CC_SEED_PATH=src/mock/seed.example.json DATABASE_URL=postgres://localhost:5432/control_center_be1b_main npm run db:seed [-- --reset]
CC_DATA=db DATABASE_URL=postgres://localhost:5432/control_center_be1b_main CC_DB_NOW=seed PORT=4351 npm run dev:web
```

`CC_DB_NOW`: `real` (default) · `seed` (the seeded asOf, then running) · an ISO instant · `HH:MM`. Use `seed`
to compare side by side with the mock, whose clock starts at the seed's time of day.

`npm run check` runs this suite with the other db projects (`test:db`); the `unit` project excludes `tests/db/**` (it is the `db-datasource` project in `vitest.config.ts`). INTEGRATE-1 (after
CONTRACT-1, ENGINES-core and BE-1a merged) brought the db DataSource onto the current contract; its pure
tests are in `tests/integration/` (unit project), its Postgres tests in `integrate1.test.ts` here.

## Files

| File | What it checks |
|---|---|
| `roundtrip.test.ts` | Seed → Postgres → read model: all 27 collections + settings, meta, spend read back equal |
| `parity-reads.test.ts` | Every read method on the mock and on db: 65 calls, contract-valid, equivalent; then the same 65 again after every table's rows were rewritten in reverse order (DB-UI: reads must not depend on physical row order), plus the key order of records the UI lists in key order (manifest form properties, tool-run inputs, NBA tool inputs) |
| `parity-mutations.test.ts` | The same mutations in the same order on both: conflict, undo/redo, locked field → proposal, resolve handed_off, dry-run dispatch, policy preview/apply/revert, capture, then every other mutation route, chat, dev routes, live events |
| `db-only.test.ts` | Seeding idempotence, engine-close change sets, draft-body undo via content revisions (W5), live dispatch → `outbox.dispatch` job (nothing sent), stale tokens, fallback order |
| `withdraw-drafts.test.ts` | OUTBOX-W: closing a to-do withdraws its pending reply drafts. Parity (resolve, dismiss + reopen, scheduled untouched: same drafts, reason, Outbox and nav count), then db only: undo restores, an approved draft and action drafts are never touched, the worker-start sweep (done + merged rows from before the rule) is idempotent in one system change set, a read-in finishing after the close saves no draft |
| `integrate1.test.ts` | The production defaults: ENGINES-core Top 3 / plan / preview / stability (`rerank`, `rerankReady`), scores persisted under the policy version row, the weight mapping (B4), undo of a policy apply; closure signals through `applySignal` with exact undo and locked-status proposals; B1 (training rows in the real table, travel rows audited + undone); chat threads, model choice, start → BE-6 error persisted, a scripted backend's redacted parts, receipt undo state and proposal status on read, chat ops as actor `chat` without locks; a TOOLS manifest via `toToolAdapter` + `validateInput`; `GET /people`; preview ≡ dispatch payload with sanitized html |

## Normalizations (applied to both sides before comparing)

| # | Normalization | Why |
|---|---|---|
| N1 | Embedded PersonRefs compare by `{id, name}` | db resolves refs from `people`; a ref may carry the person's role / isExternal where the mock's snapshot omitted them |
| N2 | `userLockedFields` compare as sets | db keeps lock lists sorted (`user_locked_fields` is a sorted array) |
| N3 | Seed ids → db ids (`translate.ts`: key-based, `id` / `*Id` / `*Ids`, plus in-app hrefs and confirm tokens); runtime ids (nanoid vs uuid / bigserial) → first-seen placeholders | Postgres keys are uuids (v5 of the seed id) and bigints |
| N4 | Instants written at request time → placeholder (`times: true` in mutation tests) | the helper stamps some columns with the database clock |
| N5 | Arrays the contract leaves unordered, or orders with an id tie-break (work-list ties, siblings, account items) compare sorted | ties break by id, and seed ids sort differently from uuids |
| N6 | Instants compare as instants (round trip) | Postgres returns canonical UTC (`…000Z`); a seed may carry offsets |

## Read order (DB-UI)

Every loader orders explicitly, by `(created_at, id)` unless the view has its own key (scan runs by `started_at`,
the event log by `last_occurred_at`, kv by key). An unordered SELECT returns rows in physical order, and an UPDATE
moves a row to the end of its heap: before this, a seeded database that had seen a re-rank listed Globex's
Renewal before its Expansion on the Account page, and lists could reshuffle after the next write. Rows a seed
writes in one transaction would tie on `created_at`, so the seed stamps them with `orderedAt(ordinal)` (the
transaction time, or the record's own instant, plus `ordinal` µs: inside the millisecond, so contract instants are
unchanged). A database seeded before this change still reads in a stable order (ties fall to the id); reseed
(`--reset`) to get the mock's order back.

jsonb does not keep object key order either (it stores keys shortest first). Records the UI lists in key order
keep theirs beside them: a seed manifest's form properties (`fieldOrder` in ext), tool-run inputs (`inputOrder` in
ext) and NBA tool inputs (`toolInputsOrder` in the NBA payload); `inKeyOrder()` restores it on read. Before this
the db-mode run form read "Talk track name, Event, Customer" and the Tools row summarized a run by its name
instead of its customer.

Known order difference (N5): an Account's tasks list in creation order on db and in seed order on the mock; both
are stable (`getAccount` compares items sorted by id).

## Intentional differences

| Id | Where | db behaviour | mock behaviour |
|---|---|---|---|
| D-SIM | capture enrichment, `launchAgent`, `startToolRun`, `answerAgent`, `reauthConnector`, `scanConnector`, `retryJob`, `syncCanvas` (live), `dispatchDraft` (live) | Records the intent and enqueues a worker job (`enrich`, `tool.run`, `agent.answer`, `connector.reauth`, `scan.<source>`, `canvas.sync`, `outbox.dispatch`). Nothing progresses until the worker (BE-1a/2/4/5) runs it | Simulates progress on timers |
| D-SCAN | `scanConnector` | The scan run is `queued` (job enqueued) | `running`, then `ok` after a timer |
| D-SEND | `dispatchDraft` with dry-run off | Status `sending`, attempt `unconfirmed` (`draft_send_attempts.status = unknown`), verification `pending`, `outbox.dispatch` job for BE-4 | Simulated `staged`/`sent` + read-back |
| D-DRY | `dispatchDraft` in dry-run | Returns the `DispatchResult` (dryRun: true, the rendered payload, outcome `rendered`), exactly like the mock. The contract reserves the 423 `dry_run` error for endpoints that *cannot* render a dry-run payload | same |
| D-UNAUDITED | `retryJob`, `ackEvent` | `auditId: null`: `jobs` and `app_events` are not audited tables, so there is nothing to undo | an undoable audit id |
| D-RCPT | receipts (`claimMissed`, `mergeTriage`, `applyPolicy`, `revertPolicy`, `undoAudit`) | Lines come from the change set's audit rows (contract field names for work items, column names elsewhere; a policy change shows the `priority_policies` rows) | Lines come from the mock's in-memory ops |
| D-HIST | history / undo entries `changes` | Every column the change set wrote, mapped to contract fields where a mapping exists | the fields the mock op touched |
| D-LABEL | proposals | `changes[].label` only where the seed gave one (or "Draft body"), like the mock's runtime proposals | same |
| D-CHAT | `POST /chat` | `start` (ids + model = body.model ?? settings.chat.defaultModel), then the contract `error` event `upstream_unavailable` "chat backend not wired (BE-6)". The user message and the assistant message (status `error`, model, the redacted `error` part) persist in `chat_threads` / `chat_messages`; a backend plugs in as `DbDataSourceOptions.chatBackend` and uses `chatOps()` (actor `chat`) | scripted replies |
| D-DEV | dev routes | 404 `not_found` (mock only) | scenario, failure switch, engine change |
| D-RANK | Today / re-rank / policy preview / apply / chat move-to-top | **ENGINES-core** (`enginesRanker`, the default): `rankWork` + `rerank` (Top 3 stability, the engine's `rerankReady`) + `previewPolicy`; spine slots, capacity and shelves come from the engine's plan. The parity suite injects `interimRanker` (the mock's scorer) on the db side so both rank the same seed identically; ties break by id (N5) | the mock's scorer |
| D-TOOLS | `getTools` rows registered from a TOOLS manifest | `toToolAdapter(manifest, state)`; seed rows map with `ToolAdapterSeedRow` (the mock's own mapping), field order kept in ext | seed rows only |
| D-REDO | redo of an undone policy apply | 409 `conflict`: the scores computed under that version were discarded with it (migration 0006); a plain re-rank undoes and redoes exactly | redo works |
| D-HEALTH | `getHealth().worker` | From `worker_instances` heartbeats (`alive: false` until BE-1a's worker runs) | always alive |

## Where contract fields live (and the side-car)

Fields with a home in DATA-MODEL §3 are written to their columns and child tables and read back from them
(the mapping is documented at the top of each `src/server/datasource/db/store/*.ts`). What has no column yet
lives in a side-car: `user_settings` rows keyed `cc.ext/<table>/<row id>` (audited by `cc_audit_kv`, so the
same change set — and its undo — covers both). Lossy enum mappings store a *qualified override* (the contract
value plus the db value it was written against), so a later write by an engine that only knows the db
vocabulary is never shadowed.

| Table | Side-car fields (proposed columns for BE-0) |
|---|---|
| work_items | whyDetail, sources, rankReasons, signals, stale, likelyDone, reopened, dismissed, loopedBackIn, waiting.who / runId, enrichment, deliverable view, training (B1), ageDays, runIds, reevaluating, user-set startBy, why (until a score row exists), kind/state/involvement overrides |
| accounts / opportunities | dcStatus, vdpStatus, hoursQtd, team, org62Url · dcAssigned, vdpLinked, hoursQtd, nextStep, products, owner, finding/anchor-only flag |
| people / assets / calendar_events | role · updatedBy, initiativeId, workItemIds, kind/source overrides · location, prep, takeaways, source chip, attendee order |
| drafts | destination display (channelName, target, workspace, inReplyTo, recipient order), threadContext, savedAt, attempt details |
| claude_sessions / tool_runs / tool_adapters | deepLink, bgAgents, progress, resultUrl, error, waiting text + choices · progress, Agents mirror row · manifest, health message, recent runs |
| activity_entries / time_blocks | sources, accountName, date override · label, hatched |
| briefs / brief_highlights / watch_subscriptions | title, kind, through, sources, everythingElse, account/opp chips · sources · cadence override |
| connectors | cursor label, backlog, itemsToday, catchUpPct, last error message (reauth + affects ride `connectors.config`) |
| singletons | `cc.meta` (asOf, lastActiveAt, quarter, canvas), `cc.spend`, `cc.plan.slots`, `cc.ext/app_runs/*`, `cc.ext/mapping_questions/*` |

NBA presentation (primaryLabel, alternatives, tool inputs, Claude launch, update strip, versions) rides in
`next_best_actions.payload`, the schema's jsonb for NBA arguments.

## INTEGRATE-1 notes

- **Contract catch-up:** `createChatThread` (context → ext, not undoable), thread titling from the first user
  message, `chat()` as above (assistant message persisted once in a `finally`, thread context merged as
  `auto` chips for the backend), `getChatThread` refreshes proposal status from `change_proposals` and receipt
  undo state from the `undo_of_change_set_id` chain, `chat` settings section (`{version: 1, defaultModel:
  'sonnet'}` until saved), `getTools` via the ToolAdapter view, `validateInput` on runs, preview / dispatch /
  confirm token / renditions through `src/lib/compose` (`DraftPreview.html`), `getPeople`.
  `UnlinkedSourceItemDetail` rows surface only in the scanner store (`src/scanner/store-db.ts`, BE-1a), which
  already returns the full shape; no DataSource route exposes them.
- **Chat ops** (`chatOps()`, async twin of the mock's): actor `chat` (`chat.edit`, `chat.resolve`,
  `chat.capture`, `chat.note`, `chat.move`, `chat.scan`, `policy.apply`), never a lock; a locked field is staged
  as a `change_proposals` group (actor `chat`). `startBy` has no column, so a locked `startBy` cannot be staged.
  Policy proposals (`proposePolicy`) still wait on BE-6.
- **Seeding:** `npm run db:seed` loads the seed (the mock's load-time ranks, so parity holds), then re-ranks once
  with ENGINES-core as a `system` change set, so `CC_DATA=db` starts from the engine's Top 3 (`--mock-rank`
  keeps the seed's ranks). `npx tsx scripts/db/engine-top3.ts` prints the engine's Top 3 next to the stored one
  (read-only).
- **Ranking:** `priority_runs` (engine version `priority@1`, policy version row, focus minutes, next meeting),
  `priority_scores` (components, lane, latest_start_at, slack, inputs hash), `priority_score_rule_hits` and
  `priority_plan_steps`. The work-item lane cache holds the engine lane, so Q1 orders Top 3 / Now / Next /
  Later. `why` stays the scanner's line (the engine's explanation is in `rankReasons`).
- **Weights (B4):** one module, `src/server/datasource/db/policy-map.ts` (table in its header):
  customer_facing → stakeholder_importance and manager_ask → commitment stay weights (the user's own rules
  already express both; rules too would double count), `obligation` is engine-only and carries over between
  versions. Contract rules become engine boost / penalty rules (× POINTS_PER_WEIGHT).
- **Closure:** `applyClosureSignal(itemId, signal)` runs ENGINES-core `applySignal` and writes the decision as one
  engine change set (transition row, fields, proposals, sibling + `reopen_decisions`); undo is exact. User verbs
  stay direct transitions: they are unconditional user actions, not evidence-gated engine decisions (no
  confidence, reopen window or L4 autonomy), so routing them through `applySignal` would mean inventing
  evidence; they share the record shape (`resolvedRecord`) and the writers instead.
- **Migrations:** 0005 keys audit rows by `id`, else the trigger's entity column (B1); 0006 cascades runs,
  scores and rule hits with their policy version row, so undoing a policy apply works.
- **Undo and `priority_policies.version`:** BE-0's undo bumps `version` on restored rows; for policy rows that
  number is the policy's own (unique per user), so `undoAudit` moves the touched rows' numbers aside before the
  undo and restores them after (non-undoable change sets in the same transaction). Raised to BE-0.
- **Plain text:** CONTRACT-1's serializer separates blocks with a blank line; seeds carry older single-newline
  `plainText`. Bodies (`doc_json`) round-trip exactly; plain text re-derived after an undo uses the new form.

## Findings and blockers raised

- **B1 (BE-0), fixed by INTEGRATE-1 (migration 0005):** `work_item_training_details` / `work_item_travel_details`
  have no `id`, so `cc_audit`'s `row ->> 'id'` was null. Training now lives in the real table (provider label in
  ext only when the enum is lossy; `overdue` in ext). The contract has no travel fields, so travel had nothing in
  the side-car; its table is writable and undoable now.
- **B2 (W0):** in `next dev`, a DataSource shared on `globalThis` throws errors whose `AppError` class belongs to
  another route bundle, so `http.ts`'s `instanceof AppError` misses and a 409 becomes a 500. Reproduced in mock
  mode. db mode avoids it (one DataSource per route bundle, shared pool/bus/clock); the mock needs a fix in
  `src/server/errors.ts` / `http.ts` (e.g. a `Symbol.for` brand check).
- **B3 (W0), fixed by INTEGRATE-1:** `scripts/shot.mjs` probes `/api/v1/health` and applies `--scenario` only when
  `/api/v1/dev/scenario` answers (mock mode); otherwise it skips it with a warning.
- **B4 (BE-0 / ENGINES), resolved by INTEGRATE-1:** one mapping module (`db/policy-map.ts`, tested in
  `tests/integration/policy-map.test.ts`), see the INTEGRATE-1 notes.
- **B5:** `priority_scores` is not audited, so `why` / `startBy` edits by an engine are not undoable; undo of a
  re-rank restores the work-item cache (rank, score, pointer to the previous score row), which is what reads use.
