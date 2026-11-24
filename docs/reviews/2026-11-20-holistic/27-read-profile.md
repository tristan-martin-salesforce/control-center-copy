# 27. Read profile, post-2.0 (`post-read-profile`, 2026-11-21)

**Goal.** Every page read is one round of queries, sized to what the page shows, on a realistic database. This chunk profiled every page on the sample database. It fixed what the profile showed: repeated reads, pages still on `WHOLE`, a base read sent several times per model, whole rows where the page needs a few columns, and one missing index. A budget test now holds each page's statement count. Follows [15-page-reads.md](15-page-reads.md); its "Read profile, post-2.0" section is the short form of this report.

## How it was measured

- **Database:** the sample (`sample-data/tables`, 16,660 rows in 120 tables, about one month of one SE's work), loaded with `npm run sample:load -- --db control_center_sample_postprof` on a database migrated to 0039. The clock is the seed's (2026-11-18T16:00:00Z).
- **Command:** `DATABASE_URL=… npm run db:read-profile -- --route all --runs 7 --compare`. The tool now covers every page (below). **ms** is the median of 7 warm runs, taken while other builders' suites ran. Read ms as a direction, not a benchmark. Statement, row and byte counts are exact and repeat run to run.
- **Before** is the integration branch at `0886871` with the scopes on, i.e. what pages actually sent before this chunk. (The tool's own "before" column is `CC_READ_SCOPES=off`, the 1.x reads. That is not the comparison here.)
- **Scale check for the index:** a scratch copy of the sample with 38,499 source items (each one copied 40 times, shifted 9 days back each time: about a year) and 30,080 jobs (a month of finished ones). It was used only for `EXPLAIN (ANALYZE, BUFFERS)` and then dropped.

### What the tool gained (`scripts/db/read-profile.ts`, d987952)

- **New routes:**
  - every Work tab (`work:said_by_me`, `work:asked_of_me`, `work:promises`, `work:trainings`, `work:snoozed`);
  - the Closed tab's second page (`work:closed:page2`, using the cursor that `limit: 20` returns);
  - `briefs`, `agents`, `assistant:threads` (GET /chat/threads), `settings`, `getting-started` (GET /guide).
- **`--dupes`:** per route, the scopes its models were loaded for, plus the statements that exactly repeat an earlier one in the same request (same text and parameters, compared by a hash kept in memory and never printed).
- **`--statements`:** every statement of a route in order, with the tables it names, rows, KB and ms.

## Before → after (sample database)

Scope: the read-model scope each route loads (`--dupes` prints it).

| Route | Scope | Queries before → after | Rows before → after | KB before → after | ms before → after |
|---|---|---|---|---|---|
| home | briefing | 84 → 79 | 3757 → 3692 | 2885 → 2225 | 40 → 38 |
| today | briefing | 81 → 76 | 3752 → 3687 | 2883 → 2222 | 35 → 33 |
| needs | needs (one whole model) | 105 → 92 | 4580 → 4362 | 3338 → 2586 | 46 → 37 |
| triage | triage | 40 → 34 | 2359 → 2262 | 2021 → 1359 | 23 → 15 |
| outbox | outbox | 33 → 27 | 1495 → 1398 | 1314 → 954 | 11 → 13 |
| activity:log | activity:log | 43 → 39 | 3191 → 3126 | 1972 → 1592 | 22 → 23 |
| activity:rows | activity:rows | 41 → 37 | 2872 → 2807 | 1855 → 1476 | 23 → 21 |
| activity:ledger | activity:ledger | 21 → 17 | 563 → 498 | 248 → 228 | 8 → 9 |
| history | activity:history | 48 → 44 | 3680 → 3615 | 1882 → 1507 | 31 → 28 |
| vdp | vdp | 46 → 36 | 1220 → 1047 | 594 → 538 | 12 → 13 |
| deals | deals | 39 → 33 | 883 → 786 | 611 → 405 | 13 → 14 |
| account | account | 53 → 47 | 1719 → 1622 | 575 → 552 | 13 → 15 |
| item | item | 49 → 43 | 1427 → 1330 | 727 → 670 | 12 → 12 |
| health | health | 41 → 35 | 1145 → 1048 | 991 → 610 | 18 → 14 |
| briefs | `WHOLE` → briefs | 60 → 15 | 4196 → 304 | 3162 → 88 | 36 → 4 |
| agents | `WHOLE` → agents (post-caps-ui, 61fc923) | 60 → 56 → 15 | 4196 → 4131 → 270 | 3162 → 2479 → 93 | 33 → 26 → 4 |
| assistant:threads | `WHOLE` → chat | 60 → 13 | 4196 → 280 | 3162 → 96 | 33 → 3 |
| settings | `WHOLE` → settings | 60 → 11 | 4196 → 216 | 3162 → 55 | 34 → 2 |
| getting-started | `WHOLE` → guide | 62 → 20 | 4198 → 847 | 3162 → 412 | 37 → 8 |
| work:open | work | 37 → 31 | 980 → 883 | 616 → 411 | 13 → 11 |
| work:said_by_me | work | 37 → 31 | 751 → 654 | 376 → 258 | 10 → 8 |
| work:asked_of_me | work | 37 → 31 | 626 → 529 | 228 → 173 | 8 → 8 |
| work:promises | work | 33 → 27 | 565 → 468 | 150 → 129 | 6 → 6 |
| work:trainings | work | 37 → 31 | 584 → 487 | 170 → 141 | 7 → 7 |
| work:snoozed | work | 37 → 31 | 575 → 478 | 160 → 135 | 7 → 6 |
| work:closed | work | 37 → 31 | 886 → 789 | 532 → 355 | 13 → 9 |
| work:closed:page (limit 50) | work | 37 → 31 | 886 → 789 | 532 → 355 | 12 → 11 |
| work:closed:page2 (limit 20, page 2) | work | 37 → 31 | 706 → 609 | 310 → 225 | 9 → 10 |
| work:search | work | 36 → 30 | 1305 → 1208 | 1007 → 643 | 16 → 13 |
| work:account | work | 33 → 27 | 559 → 462 | 150 → 129 | 6 → 5 |

Exact repeats per request, before: every page repeated `people`. Home and Today also repeated `need_decisions`. VDP repeated 5 statements (`vdp_records`, `accounts`, the opps with the DC split, `need_decisions`, `people`), and Needs repeated 10. **After: none on any route.** The budget test holds this.

## What the profile showed, and each fix

1. **The model base sent the same reads several times** (1e966af, a79bc63). Every model is every page, so each statement saved here is saved on all of them.
   - `users` was read three times per model: by the base, by the people directory and by the vocabulary.
   - `people` was read twice: by the directory and by the person refs.
   - The vocabulary (task types and meeting types: 3 statements) was read even for pages with no activity rows. Only activity rows and writers use it.
   - `user_settings` was read twice: the `cc.*` kv, and then every row of the user to find the `settings.*` sections.
   - **Fix:** the users row is read once and shared, and the people rows are read once and handed to the refs. The vocabulary loads only when the scope reads activity or is `WHOLE`. One read of `user_settings` (`cc.%` or `settings.%`, ordered by key, so the kv keeps `loadKv`'s order) feeds both.
   - **Effect:** the base is 11 statements, down from 16. Settings, which reads only the base, now sends 11.
2. **Pure reads that did not open the read memo** (9df3792, cdceee4).
   - GET /deals/vdp read the mirror, my book and the gap entities twice: once from `vdpState`, once from the use-case inputs.
   - GET /needs read the same helpers from several providers.
   - `need_decisions` was read twice on every page with the use-case plan: by the kv overlay and by `loadNeedDecisions`.
   - **Fix:**
     - `getVdpCoverage` and `listNeeds` open `withReadMemo`, as Home and Today do.
     - The `need_decisions` rows, the DC holds, the use-case holds and the VDP connector's status read once per memo.
     - A memo loader must be an `async` function. A bare drizzle query is a lazy thenable, so each `await` runs it again; the first try at the connector status showed exactly that repeat.
   - **Effect:** VDP sends 36 statements (46 before) and Needs 92 (105).
3. **Pages still on `WHOLE`** (8e16593). Briefs, the Assistant's thread list, Settings and Getting started loaded every collection to show a few. Each now has a scope:
   - `briefs`: briefs and their watches;
   - `chat`: the threads;
   - `settings`: the base only;
   - `guide`: connectors and drafts.

   Each reads through `ctx.read`, so a scope miss throws in tests and retries at runtime. The thread list keeps `ctx.model` because it may create the default thread. **Effect:** 60 → 11–20 statements, 4,196 → 216–847 rows, and 2–8 ms instead of about 35.
4. **Whole source-item rows behind every evidence chip** (4354e4b).
   - The evidence read and the derived source chips (Work, Home, Triage, Outbox, Activity) selected every `source_items` column: the search vector, the scan-run ids and 30 other columns the chip never reads.
   - **Fix:** they select the 7 columns a chip reads (`sourceChipCols`); the evidence read adds `body`, for its snippet.
   - **Effect:** Home sends 23 % fewer bytes (2,885 → 2,225 KB), Triage 33 % fewer, Outbox 27 % fewer, the Work tabs 14–36 % fewer.
5. **One missing index: 0039 `source_items_owner_first_seen_idx`** on `source_items (owner_user_id, first_seen_at)` (9065e56).
   - **The query:** `loadConnectors` counts today's source items per connector by `first_seen_at`. It runs on every page that shows connectors: Home, Today, Triage, Outbox, Deals, Account, Item, Work, Health, Getting started and Needs.
   - **The problem:** no index covered `first_seen_at`, so the count was a seq scan of every source item the user has.
   - **On the scale copy (38,499 items):** the seq scan read 14,133 buffers (110 MB), 8.8 ms warm and 23 ms cold. The index scan reads 151 buffers in 0.06 ms.
   - **On the sample (939 items)** the seq scan is 0.1 ms, which is why 15-page-reads.md finding 4 found no index missing. The table grows with every scan, so the cost would have grown with it.
   - **The migration:** additive, journal idx 37, `when` 1795306200000 (after 0038's). The snapshot is chained to 0038's id, and the generated `0037_` file was renumbered as the 0037 and 0038 chunks did. `drizzle-kit check` is clean, and `db:generate --name probe` produces nothing.
   - **Other tables:** no other page statement seq-scans a table over 2,000 rows on the scale copy. On the sample, the remaining seq scans are planner choices on tables under 1,000 rows. Each filters on a column that already has an index: evidence by item, the source item primary key, attendees by meeting, jobs by owner and kind. The 30,080-job copy used the jobs index.
6. **No N+1 loops.** No page sends a statement per row. The most a page sends for one table is 3–5 statements, and each has a different shape (the window ids, the rows, the kv overlay's promoted columns).

## Pinned

- **`tests/db/reads/profile-budget.test.ts`** (new). It loads the sample and, for each of the 30 routes above, holds two things:
  - an upper bound on statements per request, with the reason written next to it;
  - zero exact repeats.

  A budget is the measured count plus 1–4. Raise one only with a stated reason; a repeat is never allowed.
- **`tests/db/reads/page-reads.test.ts`** now includes Briefs, the thread list, Settings and Getting started. Every page renders the same JSON scoped and unscoped, in strict mode.
- **Unchanged and green:**
  - `parity-reads.test.ts` (db against mock);
  - `home-sql.test.ts`, whose Home and Today bounds still hold;
  - `work-list.test.ts`;
  - the migration journal test, which lists 0039.

## Left, and why

- **Agents (GET /agents): fixed (post-caps-ui, 61fc923).** An `agents` scope (`agentRuns`, `toolRuns`, `toolAdapters`, `people`) in `reads/scope.ts`; `getAgents` and `getTools` (the Agents page's tool panel) read through `this.ctx.read(AGENTS, …)`. Measured on the sample (`control_center_sample_capsui`, `--route agents --runs 7 --compare`): 56 → 15 statements, 4,131 → 270 rows, 2,479 → 93 KB, no exact repeats (`--dupes`). The budget test holds it at 16; `page-reads.test.ts` renders Agents and Tools the same scoped and unscoped in strict mode, and Agents reads no calendar, drafts, evidence, NBAs, chat, briefs or time blocks. The mock path is unchanged and `parity-reads.test.ts` is green.
- **Needs: 92 statements, every collection.** This is by design (15-page-reads.md): its providers read 14 weeks of activity and every meeting. Scoping it means scoping each provider.
- **The kv overlay's promoted-column reads** (4 statements per model, almost always 0 rows: D-98's dual read). Folding them into one UNION would change how each column's type comes back (timestamps, numerics), and the overlay goes away with 2.1's contract step. Not worth the risk for 3 statements.
- **Drafts load whole on Home, Outbox and Activity** (141 rows, 213 KB on the sample). The pages show open drafts, the logging canvases and the sent log. A window needs the Outbox's Sent list paged, which is a contract change.
- **Activity ▸ Log it and Rows read every activity row** (182 on the sample). Their suggestions match 14 weeks back against every meeting (15-page-reads.md).

## Reproduce

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
createdb control_center_sample_x && DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:migrate
npm run sample:load -- --db control_center_sample_x
DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:read-profile -- --route all --runs 7 --compare
DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:read-profile -- --route all --runs 1 --dupes   # scopes, repeats
CC_TEST_DB_SUFFIX=x npm run test:db -- tests/db/reads/profile-budget.test.ts
dropdb control_center_sample_x
```
