# 15. Page-scoped reads: before and after (p4-page-scoped-reads, 09 R2)

**Scope.** Pages read what they show. Nothing loads the whole world per request. Every read model is loaded for one named scope (`src/server/datasource/db/reads/scope.ts`). The row windows are in `reads/rows.ts`. GET /needs shares one model per request (`reads/session.ts`). Docs: ARCHITECTURE §4, and the EDGE-CASES section "Page-scoped reads" (RD-1..RD-5).

## How it was measured

The command: `npm run db:read-profile -- --route all --runs 11 --compare` (`scripts/db/read-profile.ts`). Each route runs with the scopes off and on.
- **Off** is `CC_READ_SCOPES=off`, exactly the 1.x reads: every collection, every row, one model per read.
- The two runs are **interleaved run by run**, so machine load hits both alike.
- **ms** is the median of 11 warm runs.

The other columns:
- **Tables**: the distinct tables the route's SQL named.
- **Rows / KB**: rows returned and their JSON size. A row is counted once in Rows even when its statement names several tables.
- **Queries**: statements sent.

The profile records table names, counts and timings only, never ids or contents.

Two databases were profiled.
- **Sample database**: `sample-data/tables` loaded into a scratch database with `npm run sample:load`. It holds 16,660 rows in 120 tables, about one month of one SE's work.
  - Its `tool_adapters` rows carry keys and versions the contract rejects (`blueprint_outline`, `1.4.0`), so every read model failed on it.
  - The scratch copy had them normalized first. The sample data needs that fix from its owner; this chunk didn't make it.
- **be1b database**: the placeholder seed (`src/mock/seed.example.json`) loaded through `scripts/db/seed-from-mock.ts`. This is what the parity suite loads.

The machine ran other builders' suites at the same time, so absolute ms are noisy. Home's scopes-off median ranged from 104 to 277 ms across runs. The interleaved before/after pairs are comparable.

## Sample database (the realistic one)

| Route | Tables before → after | Rows before → after | KB before → after | Queries before → after | ms before → after |
|---|---|---|---|---|---|
| home | 62 → 58 | 4761 → 4004 | 3445 → 3023 | 108 → 104 | 170 → 154 |
| today | 61 → 57 | 4673 → 3916 | 3404 → 2982 | 99 → 95 | 98 → 82 |
| needs | 69 → 69 | 46640 → 4680 | 34970 → 3354 | 704 → 104 | 1293 → 162 |
| triage | 52 → 33 | 4230 → 2359 | 3177 → 2033 | 61 → 40 | 96 → 52 |
| outbox | 50 → 25 | 4196 → 1495 | 3162 → 1314 | 60 → 33 | 72 → 31 |
| activity:log (To log) | 50 → 34 | 4196 → 3191 | 3162 → 1972 | 60 → 43 | 75 → 59 |
| activity:rows | 50 → 32 | 4196 → 2872 | 3162 → 1855 | 60 → 41 | 72 → 51 |
| activity:ledger | 50 → 14 | 4196 → 563 | 3162 → 248 | 60 → 21 | 75 → 19 |
| history | 51 → 35 | 4356 → 3680 | 3175 → 1882 | 62 → 48 | 80 → 59 |
| vdp | 56 → 28 | 4423 → 1220 | 3298 → 594 | 81 → 46 | 83 → 23 |
| deals | 51 → 25 | 4280 → 883 | 3200 → 611 | 67 → 39 | 80 → 21 |
| account | 51 → 39 | 4280 → 1719 | 3200 → 575 | 67 → 53 | 75 → 24 |
| item | 50 → 37 | 4196 → 1427 | 3162 → 727 | 60 → 49 | 70 → 23 |
| health | 59 → 31 | 4235 → 1145 | 3163 → 991 | 74 → 41 | 71 → 25 |

## be1b database (the placeholder seed)

| Route | Tables before → after | Rows before → after | KB before → after | Queries before → after | ms before → after |
|---|---|---|---|---|---|
| home | 62 → 58 | 938 → 957 | 335 → 325 | 103 → 99 | 42 → 39 |
| today | 61 → 57 | 927 → 946 | 331 → 321 | 95 → 91 | 26 → 28 |
| needs | 69 → 69 | 8585 → 895 | 3214 → 305 | 660 → 100 | 173 → 25 |
| triage | 51 → 33 | 772 → 686 | 292 → 228 | 57 → 37 | 17 → 12 |
| outbox | 49 → 25 | 769 → 547 | 291 → 179 | 56 → 31 | 16 → 8 |
| activity:log | 49 → 32 | 769 → 662 | 291 → 229 | 56 → 41 | 17 → 13 |
| activity:rows | 49 → 30 | 769 → 653 | 291 → 226 | 56 → 39 | 17 → 13 |
| activity:ledger | 49 → 14 | 769 → 507 | 291 → 157 | 56 → 21 | 17 → 8 |
| history | 50 → 33 | 776 → 725 | 291 → 224 | 58 → 46 | 18 → 15 |
| vdp | 56 → 28 | 820 → 579 | 297 → 167 | 77 → 46 | 21 → 11 |
| deals | 50 → 23 | 778 → 578 | 294 → 179 | 60 → 34 | 18 → 9 |
| account | 50 → 37 | 778 → 624 | 294 → 193 | 60 → 47 | 17 → 11 |
| item | 49 → 37 | 769 → 587 | 291 → 184 | 56 → 46 | 16 → 11 |
| health | 59 → 29 | 780 → 530 | 294 → 174 | 70 → 38 | 21 → 11 |

Home's and Today's rows rise slightly on the seed: the window's id queries return rows of their own, and the seed is all inside the window anyway.

## What each page loads

| Page | Scope | Collections | Rows |
|---|---|---|---|
| Home, Today | `briefing` (open work ± 14 days) | people, accounts, opps, missed opps, initiatives, work items, evidence, NBAs, drafts, proposals, events, slots, activity, runs, briefs, connectors, mappings, plus spend | Items: open work, plus anything closed, changed or due inside [min(now − 14 d, last active), now + 14 d], plus what open drafts and pending proposals are about, plus what those items point at. The evidence and NBAs of those items. Meetings ± 14 days, plus every meeting a loaded item serves or an initiative targets |
| Needs | `needs`: ONE model for its ten page reads | Every collection: its providers read 14 weeks of activity, every meeting, and the DC and use-case engines' inputs | Every row, once (it was 11 loads per request) |
| Triage | `triage` | people, accounts, opps, missed opps, initiatives, items, evidence, events, mappings, connectors | The briefing's item window (Closed for you is 14 days) |
| Outbox | `outbox` | people, drafts, items, evidence, connectors | Only the items the drafts are about, and their evidence |
| Activity ▸ To log | `activity:log` | people, activity, drafts, events, time blocks, accounts, opps, runs, assets, items | All: the suggestions match rows from 14 weeks back against every meeting |
| Activity rows | `activity:rows` | The same, without time blocks | All |
| Ledger | `activity:ledger` | people, activity | All (a quarter report; `quarter` is its page) |
| History | `activity:history`, plus the month or day | people, accounts, activity, runs, drafts, events, time blocks, items | The month grid's (or the day's) window: items closed, created, closed by log or sent about in it; meetings and blocks overlapping it; activity worked or stamped in it |
| VDP | `vdp` | people, accounts, opps, drafts | All |
| Deals | `deals` | people, accounts, opps, missed opps, items, connectors | Live items only (for the open-task counts). Paging with the additive `cursor`/`limit` |
| Account | `account:<id>` | people, accounts, opps, missed opps, initiatives, items, assets, runs, briefs, events, connectors | That account's items. Its needs come from its own row |
| Work item | `item:<id>` | people, accounts, opps, initiatives, items, evidence, NBAs, proposals, assets, drafts, events, connectors, runs | The item, its initiative's items, what it points at and what points at it; their evidence and NBAs; the meetings they serve |
| Health | `health` | people, connectors, items (stale counts), plus spend | All. The ledgers are SQL counts; the jobs list loads `ops` |

Every model also reads the base: the user, settings, policies, the people directory and the kv map. The kv read (`loadKv` → `overlaySidecar`) also reads a few promoted columns of `work_items`, `activity_entries`, `opportunities` and `accounts` (D-98).

Writers load `everything('write: <action>')` inside their transaction. The 155 call sites outside the page table load `WHOLE` (`everything(...)` with its reason, in db/index.ts). Scoping them is the next step.

## Findings

1. **Needs was the outlier.** It sent 704 statements and returned 46,640 rows (~35 MB) per request on the sample: eleven full model loads. Now it is one load: 104 statements and 4,680 rows, about 8× faster.
2. **Every other page except Home and Today loads 40–85 % fewer rows** and runs 1.3–4× faster. The ledger, VDP, Deals, Account, Item and Health pages take about a quarter of their old time.
3. **Home and Today** load 4 fewer tables and 16 % fewer rows on the sample. Their time is within noise to −17 %.
   - **Why the window cuts little here:** the sample spans one month, and 99 of its 107 work items changed in the last 14 days. On a real year of history, closed work dominates and the window is the right bound. RD-1 covers what it keeps.
   - **Where Home's time goes:** of its ~130 ms (warm, under load), the briefing model is ~74 ms. Home's own SQL after the model is the other ~56 ms: since digest, Q1 ranks, Q6 closes, VDP coverage, DC requests and use-case sync.
   - **Against the target** (Home, Today and Needs under ~150 ms on the sample):

     | Page | Interleaved table | Quieter runs |
     |---|---|---|
     | Today | 82 ms | — |
     | Needs | 162 ms | 115–146 ms |
     | Home | 154 ms | 108–130 ms |

     On the be1b seed all three are under 40 ms.
   - The next win for Home is that post-model SQL, not the model.
4. **No index was needed.** Every window query is an `owner_user_id` plus status or timestamp scan over a few hundred rows, under 2 ms each on the sample. No migration was added: `0037_read_indexes` isn't needed.
5. **Correctness is pinned.**
   - On the seed, every page renders byte-identical JSON scoped and unscoped, in strict mode (tests/db/reads/page-reads.test.ts).
   - The db-datasource (be1b) parity suite passes unchanged: 379 tests.

## Reproduce

```sh
createdb control_center_sample_x && DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:migrate
npm run sample:load -- --db control_center_sample_x
DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:read-profile -- --route all --runs 11 --compare
# --collections: the read-model collections each route read; --slow: its five slowest statements
```

## Home SQL, post-2.0

Finding 3 named the next lever: Home's own SQL after the read model. This section is that work (`post-home-sql`, 2026-11-21).

### How it was measured

- The sample database: `sample-data/tables` loaded into a scratch database with `npm run sample:load`, then migrated to 0037. Its `tool_adapters` rows now pass the contract, so no normalizing was needed.
- `--post-model` is new in `scripts/db/read-profile.ts`. It splits each run at the moment the route's read model resolved and prints three numbers, each the median of the runs:
  - the statements sent after that moment;
  - their summed ms;
  - the wall ms from the model to the response.
- Summed ms includes each statement's wait for the event loop while its siblings run concurrently, so it can exceed the wall time.
- The machine was quieter than for the tables above: Home's median is 49 ms here, against 108–154 ms there.

```sh
createdb control_center_sample_x && DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:migrate
npm run sample:load -- --db control_center_sample_x
DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:read-profile -- --route home,today --runs 21 --post-model
```

### What ran after the model (before)

Home sent 48 statements after the model, and Today sent 39. The five costliest, by time and by repetition:

1. **Q1, the ranked list: 5 ms, the slowest statement on Home.**
   - It ran in full: the score's why, the NBA, the opportunity, the initiative, the origin link (a lateral join) and the degradation view (a UNION over evidence and source items) for each of 31 rows.
   - `rankedIds()` reads only the ids.
2. **The VDP mirror and my book, read four times each.**
   - `vdp_records` (with its children), the accounts and the opps with the correlated DC-split subquery (50 rows each time) were read by:
     - the VDP coverage (`vdpState`);
     - the use-case plan's inputs, twice: once for the coverage and once for the waiting-for-a-canvas count;
     - the Deals needs' VDP links (`loadVdpOppIds`).
   - About 4 ms in all.
3. **The use-case plan's inputs, read twice.** These are `org62_use_cases`, `org62_use_case_reads`, the use-case holds (a drafts payload scan), my Org62 id, `need_decisions` with its kv fallback, and `canvas_row_overrides`: 9 statements each time.
4. **The DC requests, read twice.**
   - Each time: the requests, my DCs and the DC holds (a second drafts payload scan).
   - Once for the Deals needs and once for the waiting count.
5. **Q6, closed for you: 1.2 ms.** It joins the evidence, source items, asset diffs and assets for two columns it never reads.

The pattern cost more than any single statement: everything ran **one after another**.
- `buildHome`'s argument list awaited the forecast, VDP, DC needs and waiting count in turn.
- `vdpState` awaited 11 reads in turn.

The post-model wall time (19–20 ms) was longer than the summed statement time (16–17 ms).

### What changed (output byte-identical)

1. **Concurrent, not serial.**
   - Home runs Today's capacity, the since digest, the forecast, the VDP summary, the DC needs and the waiting count in one `Promise.all`.
   - `vdpState` runs its 11 independent pool reads in one `Promise.all`.
2. **One read per request.**
   - `withReadMemo` / `readMemo` (`db/reads/session.ts`) is an AsyncLocalStorage map, keyed by the db handle plus a key.
   - `getHome` and `getToday` open it.
   - Inside it, `loadVdpRecords`, `loadGapEntities`, `loadUseCaseInput` and `loadDcRequests` (with no holds or DCs passed in) read once and share the promise.
   - **Request-scoped by construction.**
     - Outside a session, the loaders read as before.
     - A transaction is another handle, so a writer never sees the pool's memo.
     - Only the two pure reads open it.
     - A failed load is forgotten.
   - **No cross-request cache.** Two GET /home read the mirror twice; the test pins this.
3. **Ids-only Q1 and slim Q6.**
   - `rankedIds()` sends Q1's WHERE, ORDER BY and LIMIT and selects only `id`.
   - `closeEntries` sends Q6's WHERE and ORDER BY and selects only the item and its undo change set.
   - The dropped joins were all on primary keys, so the rows and their order are the same.
   - `src/db/queries.ts` keeps the DATA-MODEL §6 text verbatim.
4. **One index, `0037_home_indexes`.**
   - The index is `drafts_owner_canvas_idx`: `drafts (owner_user_id) WHERE payload ->> 'action' = 'slack_canvas.create'`.
   - **The problem:** the DC and use-case holds read every one of the owner's drafts and their payloads to find the logging canvases. That cost grows with a year of drafts.
   - **On the sample:** a seq scan of 141 drafts took 0.39 ms; the index scan takes 0.01 ms.
   - Additive: journal idx 35 and `when` 1795306000000 (after 0036), with the snapshot chained. `drizzle-kit check` is clean, and `generate --name probe` produces nothing.
   - **No other index was missing.** Every remaining post-model statement is an owner-keyed index or primary-key read under 0.5 ms when run alone.

### Before → after (sample database, median of 21 warm runs, two passes)

| Route | ms (median) | Statements | After the model: statements | summed statement ms | wall ms |
|---|---|---|---|---|---|
| home | 48–50 → 38–39 | 104 → 84 | 48 → 28 | 16 → 14–15 | 19 → 8 |
| today | 36–38 → 34 | 95 → 81 | 39 → 25 | 17 → 11 | 8 → 5 |

**Targets: met.**
- Home's post-model SQL is 8 ms of wall time, and 14–15 ms summed. The target was under 20 ms.
- Home's median is 38–39 ms. The target was under 100 ms.

**Byte-identical output, proven two ways.**
- **Sample JSON diff:** `GET /home` and `GET /today` on the sample, at a pinned clock (2026-11-18T16:00:00Z), rendered to JSON before and after. The files are identical: `cmp` found no difference.
- **Page-reads test:** `tests/db/reads/page-reads.test.ts` passes unchanged. It checks every page on the seed, scoped against unscoped, in strict mode.

**Pinned.** `tests/db/reads/home-sql.test.ts` loads the sample and holds two upper bounds:

| Route | All statements | After the model |
|---|---|---|
| GET /home | ≤ 88 | ≤ 30 |
| GET /today | ≤ 85 | ≤ 27 |

It also checks that one request reads the mirror, the use-case read-back and the DC requests once each, and that the next request reads them again.

**Not taken:**
- **Parallelizing `loadUseCaseInput`'s own reads.** It stays serial because D-70's landing sync calls it inside a transaction.
- **Reading `need_decisions` from the model's kv.** The D-98 dual-read window still needs the table read.

Neither is needed for the targets.

## Work list scope, post-2.0

The Work list (`/work`, GET /items) was the largest read left on `WHOLE`: every item of every state, its evidence-derived chips, links and training rows, plus every other collection, to show one tab (19-read-twins.md, "Work lists"). This section is that work (`post-work-list-scope`, 2026-11-21).

### What changed

1. **A `work` scope** (`reads/scope.ts`, built from the list query) and its window (`reads/work-list.ts`).
   - **Collections:** people, accounts, opps, initiatives, work items, events, connectors: what `workListView` and `hydrateItem` read. Accounts, opps and initiatives load whole, as the briefing's do. Meetings load by id: the ones the loaded items serve, plus the initiatives' targets.
   - **Rows, the exact path** (no text and no source filter): only the tab's rows.
     - Account, opp, initiative and kind are exact in SQL.
     - State and kind are the loader's: the enum mapped back, or the kv override stored under that enum value.
     - The tab rule is a VALUES table generated from the view's own `tabMatch`, so SQL and the view cannot drift.
     - Every tab's count is **one SQL query** over the same filters (`workListCounts`).
   - **Rows, the superset path** (text or source): the why text and the source chips are derived by the loader (the score or the kv; the kv or the evidence). So SQL narrows to a superset over every tab's states, and the view filters and counts exactly, as before.
     - An ASCII search narrows by lower-cased containment over title, purpose and why. Any other search is not narrowed, because SQL and JS fold case differently.
     - A source filter narrows to the items whose kv chips or non-app evidence carry that source.
   - **An index prefilter:** the stored statuses a tab's states come from (`work_items_owner_status_idx`). A reopen's kv override rides on `open`, by the writer's own rule.
2. **Closed is paged** with the additive `cursor`/`limit` (`ItemsQuery`), and `nextCursor` (`ItemsPayload`), as Deals does.
   - **The db pages in SQL**, in the view's order: closed newest first at ISO-millisecond precision, then created, then id.
   - **The mock pages the view's rows.** The cursors are the same `o:<offset>` on both.
   - **No `limit`:** the payload is unchanged.
   - **`total`:** the tab's rows over every page, which is what it already was without paging.
3. **`listItems` reads through the scope.** The view is unchanged.
   - The separate structural-candidates query is gone: the window holds only candidates.
   - **WL-3 is kept:** a failed window query reads every item, and a failed count query renders from `everything(…)`.

### How it was measured

The command: `npm run db:read-profile -- --route work --runs 11 --compare`. `--route work` is new. It runs five queries:
- `work:open`: the default tab;
- `work:closed`: the Closed tab, whole;
- `work:closed:page`: the Closed tab with `limit: 50`;
- `work:search`: `q: 'e'`, the worst case, which matches nearly every item;
- `work:account`: one account.

**Before** is the scopes-off read, `CC_READ_SCOPES=off`. That is exactly the `WHOLE` model `listItems` loaded. The old code also sent one more id query when an account, opp or initiative filter was set.

The runs are interleaved, as above, and **ms** is the median of 11 warm runs. Other builders' suites were running at the same time.

Two databases:
- **Sample database:** `sample-data/tables`, loaded with `npm run sample:load` into a scratch database. It holds 107 items: 41 live, 2 snoozed, 48 done and 16 suggested, dismissed or merged, about one month.
- **Year database:** a scratch copy of the sample, with every done, dismissed and merged item copied 11 more times, shifted back 30 days each time, evidence included. That makes 745 items with 576 closed: a year of closures over the same open work. Synthetic, scratch only, dropped after.

### Before → after

**Sample database** (one month):

| Route | Tables before → after | Rows before → after | KB before → after | Queries before → after | ms before → after |
|---|---|---|---|---|---|
| work:open | 50 → 25 | 4202 → 980 | 3162 → 616 | 61 → 37 | 32 → 13 |
| work:closed | 50 → 25 | 4202 → 886 | 3162 → 532 | 61 → 37 | 31 → 11 |
| work:closed:page | 50 → 25 | 4202 → 886 | 3162 → 532 | 61 → 37 | 32 → 12 |
| work:search | 50 → 25 | 4196 → 1305 | 3162 → 1007 | 60 → 36 | 33 → 14 |
| work:account | 50 → 22 | 4196 → 559 | 3162 → 150 | 61 → 33 | 31 → 5 |

**Year database** (576 closed):

| Route | Tables before → after | Rows before → after | KB before → after | Queries before → after | ms before → after |
|---|---|---|---|---|---|
| work:open | 50 → 25 | 8701 → 980 | 11665 → 616 | 61 → 37 | 87 → 10 |
| work:closed | 50 → 25 | 8701 → 3713 | 11665 → 4554 | 61 → 37 | 82 → 39 |
| work:closed:page | 50 → 25 | 8701 → 895 | 11665 → 543 | 61 → 37 | 81 → 11 |
| work:search | 50 → 25 | 8695 → 4132 | 11665 → 5029 | 60 → 36 | 80 → 40 |
| work:account | 50 → 22 | 8695 → 559 | 11665 → 150 | 61 → 33 | 82 → 5 |

### Findings

1. **The open tab no longer grows with history.** On the year database it reads the same 980 rows and 616 KB as on the month, about 9× fewer rows and 19× fewer bytes than before. It takes 10 ms, down from 87.
2. **The Closed tab with a page** reads 895 rows and takes 11 ms on the year database (81 before). The whole tab still reads every closed item (3,713 rows), because that is what it shows.
   - The Work page (`app/work/**`, not this chunk's) does not send `limit` yet. Adopting it is the next step for the Closed tab.
3. **A one-letter search** is the superset path's worst case: it loads nearly every item, as the view must count them. A word narrows much further.
   - The derived chips and why text keep source and text off the exact path. Making them exact needs the chips stored (a column or a SQL-readable kv field), not more SQL.
4. **The window and count queries are cheap.** Timed alone on the year database (median of 21):
   - the open tab's window: 2.1 ms;
   - the Closed page's window: 3.1 ms;
   - the counts: 1.1 ms.

   The window's CTE is `materialized`: inlined, the planner looped the tab rule over the rows, and the open window took 7.7 ms. No index was added: the owner and status index serves the prefilter, and the kv probe is the `user_settings` primary key.

### Correctness is pinned

- **Scoped equals unscoped:** `tests/db/reads/work-list.test.ts` renders 154 list shapes the same scoped as with the scopes off, in strict mode, with no scope miss. The shapes are:
  - every tab;
  - each filter the Work page sends: account, opp, initiative, two sources, every kind, an ASCII search, an upper-case search, a one-letter search, an empty search, a search that matches nothing, a non-ASCII search;
  - three filter combinations.
- **Overrides keep the counts exact:** the test passes again after a reopen (a kv state override) and a deliverable (a kv kind override).
- **Paging, both DataSources:** the test pages the Closed tab, a Closed search and the open tab two rows at a time on both, and checks every row once, the counts and `total` on every page, and the db page equal to the mock's.
- **The window:** the open tab's model holds no closed item, and a Closed page's model holds that page.
- **Parity:** `parity-reads.test.ts` adds two paged Closed shapes to the 11 `listItems` shapes, and all stay green: 409 tests.
- **The pure parts:** `tests/reads/work-scope.test.ts` covers what the scope loads, which path a query takes, the paging, and WL-3's null window.

```sh
createdb control_center_sample_x && DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:migrate
npm run sample:load -- --db control_center_sample_x
DATABASE_URL=postgres://localhost:5432/control_center_sample_x npm run db:read-profile -- --route work --runs 11 --compare
```

## Read profile, post-2.0

This section is every page profiled on the sample database and fixed (`post-read-profile`, 2026-11-21). The full report, with the before → after table for each of the 30 routes, is [27-read-profile.md](27-read-profile.md).

- **The tool covers every page.** `npm run db:read-profile` adds:
  - each Work tab and the Closed tab's second page;
  - Briefs, Agents, the Assistant's thread list, Settings and Getting started;
  - `--dupes`: the scope each run loaded, and the statements that exactly repeat one of the same request;
  - `--statements`: every statement in order.
- **No exact repeat is left on any page.** Before, every model read `people` twice and `users` three times, and VDP and Needs re-read the mirror, my book and the use-case inputs.
  - The model's base now reads the users row, the people rows and `user_settings` once each, and the vocabulary only for scopes with activity. That is 11 statements per model, down from 16.
  - The VDP page and GET /needs open `withReadMemo`.
  - The `need_decisions` rows, the DC holds, the use-case holds and the VDP connector status read once per memo.
- **Four more page scopes:** `briefs`, `chat` (the thread list), `settings` and `guide` (Getting started). Each was `WHOLE`: 60 statements and 4,196 rows. Now each sends 11–20 statements and reads 216–847 rows. Agents and its tool panel (GET /agents, GET /tools) now read on the `agents` scope too: 56 → 15 statements, 4,131 → 270 rows (post-caps-ui, 61fc923; 27-read-profile.md).
- **Evidence chips select their 7 columns**, not the whole source-item row. Home sends 23 % fewer bytes and Triage 33 % fewer.
- **One index, `0039_read_profile_indexes`:** `source_items (owner_user_id, first_seen_at)`, for the per-connector count of today's items on every page with connectors.
  - On a scratch copy with a year of source items (38,499), the count was a seq scan: 8.8 ms warm and 110 MB of buffers per page.
  - With the index, it takes 0.06 ms.
  - Finding 4 above saw 939 rows, where that seq scan cost nothing.
- **Pinned.** `tests/db/reads/profile-budget.test.ts` holds a statement budget per route on the sample, each with its reason, and zero exact repeats.
