# 12: PGlite as the single app database (spike `p4-pglite-spike`)

Question (README §8, H-2): can PGlite be the one database that the web app, the worker and the in-process MCP tool servers all read and write, given triggers (audit/undo), `LISTEN/NOTIFY`, the `SKIP LOCKED` queue, advisory locks, `pg_trgm`/`btree_gist`/exclusion constraints, tsvector search and the Drizzle migrator? H-2 made PGlite the choice on one condition: a spike had to show that a shared PGlite connection holds under the queue and under live NOTIFY across processes. If it did not, bundled Postgres 17 was the fallback.

Everything below was run on this machine (Node 25.4, macOS, Homebrew PG 17.12) on 2026-11-20. The scratch scripts are in the session scratchpad and are not committed. Other builders were running at the same time, so treat absolute throughput as noisy. The comparisons that matter (PGlite against Postgres) were made back to back.

## 1. Verdict

**No, not as shipped, so H-2 falls back to bundled Postgres 17 for users.** PGlite stays for mock mode and tests, where it runs in-process with a single connection, and it works well there.

- **Stock `@electric-sql/pglite-socket` 0.2.20 fails the H-2 condition outright**, and silently:
  - Under the app's own `claimJobs` with two pools, 1,065 of 1,200 jobs were left `running` forever.
  - Clients were told their `UPDATE`s succeeded (a `rowCount` sum of 260) when only 135 rows changed.
  - Two transaction clients plus two autocommit clients stall the server permanently.
  - `NOTIFY` is delivered to the connection that *sent* it, not to the one that `LISTEN`ed. The app's `PgEventBus` received **0** live events.
- **A ~100-line patch to the multiplexer fixes both correctness failures in these tests.** The patch batches each extended-protocol message group up to `Sync` as one unit, and routes `NotificationResponse` to the connections that `LISTEN`ed. With it, the queue was 1,200/1,200 with no duplicates, and the bus received the same events as Postgres. What remains is structural and cannot be patched away:
  - Every connection shares one session and one executor. Any transaction blocks everyone else for its whole duration. A query on another connection from inside an open transaction deadlocks.
  - Throughput is 264 jobs/s against 9,375 on bundled PG17. Read p95 is ~100 ms against 0.2 ms while the worker writes.
  - The host's event loop stalls for up to 4.5 s.
  - Session state (`SET`, `search_path`, session advisory locks, prepared statement names, temp tables) leaks across clients.
  - `COPY FROM STDIN` wedges the server.
  - Nothing locks the data directory.
  - It would be our fork of a component whose README says "not all cases might be covered". Upstream lists "true multi-connection support" under *Coming next* ([v0.4 announcement](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)).
- PGlite 0.5.x is **PostgreSQL 18.7**, not 17. That is a Postgres major-version change for every existing user. Homebrew's `pg_dump` 17 refuses to dump it, and 15 of 939 `source_items.search_tsv` values change on restore (snowball stemmer).

**Revisit** when upstream ships real multi-connection support (cooperative or worker-thread backends). The test scripts in §8 are the re-run gate.

## 2. Measured numbers

`stock` = pglite-socket 0.2.20 as published. `patched` = the same file plus the two fixes in §5. `PG17` = Homebrew 17.12 or bundled embedded-postgres 17.12; they behaved identically on every correctness test.

| # | Test | PGlite stock | PGlite patched | Postgres 17 |
|---|---|---|---|---|
| — | Versions | PGlite 0.5.17 = PostgreSQL 18.7 (wasm32) | same | 17.12 |
| — | Download (npm tarball) | pglite 9.3 MB (26 MB unpacked) + socket 81 KB + pgvector 58 KB + tools 541 KB | same | embedded-postgres darwin-arm64 **119 MB** (300 MB unpacked: npm materialises the ICU symlinks as 3 × 55 MB copies) |
| — | Cold create (`initdb`) | 0.6 s | same | 9.6 s (`initdb`, loaded machine) |
| h | Open with sample data → accepting connections | 0.86-1.19 s | ~same | start 95-290 ms, stop 23-176 ms |
| h | Host RSS | 385-695 MB at open, 40-360 MB in use | same | small (native, shared buffers) |
| h | On-disk size with `sample-data` | 96-99 MB (51 MB base + 48 MB WAL) | same | 34 MB database (47 MB fresh cluster) |
| — | `runMigrations()` (`src/db/migrate.ts`) through the socket | **0.5 s, match**: 120 tables, 69 triggers, 24 migrations | same | 0.3 s (brew), 3.6 s (embedded, loaded) |
| h | `npm run sample:load` / `sample:validate` through the socket | 16,660 rows in 2.9 s; 404 FKs, 0 orphans | — | same rows |
| P1 | 16 clients × 300 parametrized autocommit queries, cross-check results | 0 wrong, 0 errors, 3k-25k q/s (load-dependent) | 0 wrong, 2.4k-7k q/s | 0 wrong, 45k q/s |
| a | `claimJobs` (SKIP LOCKED + dedupe advisory locks), 2 pools × 5 loops, 1,200 jobs | **FAIL**: 135 succeeded, 1,065 stuck `running`, `rowCount` sum 260 ≠ 135, errors `55000 portal "" cannot be run` ×25, `26000` ×2, `34000` ×1 | **PASS** 1,200/1,200, 0 duplicates, 0 errors, **264 jobs/s**; enqueue 1,200 in 5.1 s | PASS, 1,299-9,524 jobs/s (brew), **9,375 jobs/s** (embedded); enqueue 0.38 s |
| a′ | Minimal repro: K clients doing `begin; update …$1; commit` + K autocommit `update …$1` | K=1 pass; **K=2: permanent stall** after 201 iterations, 199 protocol errors | K=5 pass (1,000/1,000 each side) | K=5 pass |
| b | `LISTEN` on A, `pg_notify` + `cc_live_notify` trigger fired from B | **misrouted**: listener 0, *notifier* got both | listener got both | listener got both |
| b′ | App's `PgEventBus` (web) ← worker `withChangeSet` + `publish` | **0 events** | 8 events, 43-194 ms | 8 events, 116-266 ms |
| c | `withChangeSet` → `cc_audit` row → `undoChangeSet` | pass (68-126 ms) | pass | pass (33 ms) |
| d | tsvector `@@ websearch_to_tsquery` + `ts_rank`, `pg_trgm` `similarity`/`%`, `range_agg`, exclusion `23P01` | all pass | all pass | all pass |
| e | pgvector | **0.8.7, HNSW works** (`@electric-sql/pglite-pgvector`) | same | **not shipped** (neither brew nor embedded-postgres) |
| f1 | Reader on B while A holds an idle 3 s transaction | **waits 3,006 ms** | 3,010 ms | 2 ms |
| f2 | Reader on B during a 2 s statement on A | 1,950 ms | 1,973 ms | 1 ms |
| f3 | A opens a transaction, then awaits a query on connection B | **deadlock** (5 s timeout) | **deadlock** | served |
| f4 | Host event-loop lag (worker would host it) | up to 1.9 s | up to 4.5 s | n/a (separate process) |
| f5 | Page-style reads while the worker writes 20-row transactions | p50/p95/max 13.6/85/358 ms | 15.7/108/355 ms | 0.1/0.2/4.3 ms |
| — | Session isolation | **shared**: `backend_pid` 42 for every client; A's `SET TimeZone` seen by B; `pg_try_advisory_lock(4327,1)` true for **both**; named statement `stmt_x` collides; a `pg_dump` restore left `search_path = ''` for every *later* connection | same | isolated |
| g | `kill -9` host mid-transaction | client gets `ECONNREFUSED` in 1 ms; pool idle error "Connection terminated unexpectedly"; host back in 1.48 s; first query OK 1.52 s after the kill, no app code; 100/100 committed rows kept, the uncommitted one gone | same mechanism | standard crash recovery |
| g′ | Second process opens the same `dataDir` | **allowed**: no lock, so corruption is possible | same | refused (`postmaster.pid`) |
| — | `COPY … FROM STDIN` (psql plain dump, `pg_restore -Fc`) | **fails** "protocol synchronization was lost" and **wedges the host** | fails the same way | works |
| — | `COPY … TO STDOUT` | works | works | works |

In-process (no socket, for mock mode and tests): `drizzle-orm/pglite` with `migrate` applied all migrations in **0.44 s**. The app's `enqueueJob`/`claimJobs` ran with 4 concurrent callers: 200/200 claimed, 0 duplicates, 47 ms. `pgl.listen('cc_change')` received the trigger's NOTIFY. PGlite's `@electric-sql/pglite/node-postgres` adapter (a `pg.Pool` on PGlite) is **not usable**: the node-postgres migrator hangs (10 s timeout), and parametrized Drizzle queries throw `TypeError: e.types?.forEach is not a function`.

## 3. Why the stock multiplexer breaks (source: `node_modules/@electric-sql/pglite-socket/src/index.ts`)

- `PGLiteSocketHandler.handleData` enqueues **each wire message separately** into the shared `QueryQueueManager`. `node-postgres` sends Parse/Bind/Describe/Execute/Sync for every parametrized query. Another connection's messages can land between them, and so can a simple-protocol `BEGIN` from a transaction client, which is what happens in `withChangeSet` and `claimJobs`. The unnamed statement and portal are then clobbered, which explains `portal "" cannot be run` and `unnamed prepared statement does not exist`. After an error the backend discards input until the next `Sync`, so the other client's messages vanish and it waits forever (the stall). A client's `CommandComplete` can also belong to someone else's statement (the `rowCount` 260 ≠ 135).
- Transaction affinity is `db.isInTransaction() && lastHandlerId`: while any client is in a transaction, the queue serves only that client. That is correct, but it means every transaction is a global lock. A transaction that awaits anything (another connection, an LLM call, a file read) blocks the whole app, and the queue has no timeout (`CONNECTION_QUEUE_TIMEOUT` is declared but never used).
- Output bytes go only to the socket whose query is executing. Postgres emits `NotificationResponse` at commit **on the committing session**, and with one session that is whoever wrote, never the listener.
- `CancelRequest` is consumed and dropped ("PGlite has no backend process to signal"), so a runaway statement cannot be cancelled.
- Supabase reached the same conclusion before the v0.4 multiplexer landed: shared transaction state, multi-message extended-protocol sequences and shared session state make multiplexing "a bad idea" ([database.build live share](https://supabase.com/blog/database-build-live-share)). The README itself says "not all use cases are guaranteed to work" ([pglite-socket README](https://unpkg.com/@electric-sql/pglite-socket@0.2.7/README.md); [docs](https://pglite.dev/docs/pglite-socket)). The v0.4 post confirms single-user mode and puts "true multi-connection support" under *Coming next* ([PGlite v0.4](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)).

## 4. Recommended topology (fallback: bundled Postgres 17)

```
                ~/Library/Application Support/<state>/pg/        (data dir, owned by the app)
                                 │
   LaunchAgent com.controlcenter.db ── postgres 17 (embedded-postgres binaries, contrib incl. pg_trgm, btree_gist)
                                 │       listen_addresses = ''   unix socket only: <state>/pg/run/.s.PGSQL.5432
            ┌────────────────────┼─────────────────────────┐
   com.controlcenter.web     com.controlcenter.worker      CLI scripts (doctor, scan:*, sample:*)
   Next.js :4327             scanners, jobs, cc MCP tools   DATABASE_URL from the env file
   pg Pool (max 5)           pg Pool (max 5) + LISTEN       postgres:///control_center?host=<state>/pg/run
   PgEventBus LISTEN         cc_job_cancel LISTEN
   in-process MCP servers share their process's pool (src/llm/cc-tools/server.ts)

   mock mode / tests:  one process ── PGlite in-process (memory:// or tmp dir) via drizzle-orm/pglite, no socket
```

- A unix socket only (`listen_addresses = ''`) needs no new TCP port and keeps the database off the network. If a TCP port is ever needed, register one next to 4327 in `~/Projects/PORTS.md`. The socket path is ~80 characters, under the 103-character macOS limit. **Not verified here:** how node-postgres and `pg_dump` parse a socket `host=` path containing the space in "Application Support". Fallback: a short symlink such as `<state>/run` → the pg folder.
- If PGlite were ever revisited for the app DB, do **not** host it inside the worker. The WASM executor blocks the host's event loop for the length of each statement (up to 4.5 s observed), which would freeze scanners, heartbeats and leases. It would need its own `com.controlcenter.db` process like the one above.

## 5. Code changes the app needs

For the recommended path (bundled PG17 for users, PGlite for mock and tests):

1. **`src/db/client.ts`**
   - `resolveDatabaseUrl()`: env `DATABASE_URL` → env-file `DATABASE_URL` (written by setup) → the bundled socket URL, instead of `postgres://localhost:5432/control_center`.
   - Add `createDb({ engine: 'pglite', pglite })`, which returns a `DbHandle` on `drizzle-orm/pglite`.
   - Widen `Db`/`Tx` from `NodePgDatabase<Schema>` to `PgDatabase<PgQueryResultHKT, Schema>`, because both drivers return `{ rows }` from `execute`.
   - Give `DbHandle` a `query(text, params)` and a `listen(channel, fn)` so the raw `pool.query` and `LISTEN` sites stop reaching for `pg.Pool`. Do **not** use `@electric-sql/pglite/node-postgres` (it hangs and throws, §2).
2. **`src/db/migrate.ts`**: choose the migrator by engine (`drizzle-orm/pglite/migrator` for PGlite). Keep `compareSchema` as is.
3. **Events**: `src/server/events/pg-bus.ts` and `src/server/datasource/db/events.ts` use the handle's `listen` (PGlite: `pgl.listen`, which is in-process and verified above). `src/worker/runtime.ts` does the same for `cc_job_cancel`.
4. **`src/ops/lifecycle.ts` `SingleInstanceLock`**: the session advisory lock stays (real Postgres). Add an `flock`/pid check on the bundled data dir for the db agent.
5. **Bundled cluster lifecycle** (new `scripts/ops/pg-cluster.mjs`, plus `scripts/ops/lib/plist.mjs`):
   - `initdb` with `--locale=C --encoding=UTF8` and auth `peer`/`trust` on the socket only.
   - A `postgresql.conf` with `listen_addresses=''`, `unix_socket_directories`, `max_connections=30`.
   - A third LaunchAgent `com.controlcenter.db` (KeepAlive). Web and worker wait for `pg_isready`.
   - Pin `embedded-postgres@17.x` with per-arch optional deps. Optionally dedupe the ICU copies (`pg-symlinks.json`) to cut ~110 MB from the install.
6. **`CC_DATA=mock`**: the db DataSource on in-process PGlite, seeded from `src/mock/seed.example.json` through `scripts/db/seed-from-mock.ts` / `db/from-mock.ts` (09 R6). The scenario clock and dev routes move with it.
7. **Test harness**: `CC_TEST_PG=pglite` (default in `npm test`) gives a fresh in-memory PGlite per file with migrations applied in about 0.5 s. `CC_TEST_PG=server` keeps `BE0/BE1A/BE1B_DATABASE_URL` for the full-Postgres run in `check:full`. Gate any multi-connection or `pg_dump` test to `server`.
8. **`src/ops/doctor.ts`**:
   - Cluster running (`pg_isready` on the socket).
   - Data dir owned by the user, plus disk space.
   - Server major version equals the bundled binaries' major.
   - Old Homebrew database still present (show the age and the removal command after 14 days).
   - `DATABASE_URL` overridden by the user (report only).
9. **Backups** (`scripts/ops/lib/backup.mjs`, `src/jobs/handlers/backup.ts`): use the **bundled** `pg_dump` (same major as the server) instead of the hard-coded Homebrew PG17 path, `-Fc` as today. Restore with the bundled `pg_restore`.
10. **Sample data** (out of scope here, for the sample-data owner): `scripts/sample-data/load.ts` loads under `session_replication_role = replica`, which also skips the rechecks for **deferrable** exclusion constraints. `sample-data` currently holds 13 `activity_entries` rows (14 overlapping pairs) that violate `activity_entries_no_overlap_excl`. Every `pg_dump` → restore of a sample database fails at that constraint, on any engine. The loader should run `set constraints all immediate` checks, or the validator should test the exclusion predicates.

What PGlite as the app DB would additionally need (recorded for the revisit, not recommended now):
- A forked multiplexer with the two fixes. The spike diff is 122 lines, in the scratchpad as `spike/muxfix.diff`.
- A queue timeout that fails the waiting client instead of hanging.
- An audit that no code awaits another connection or an external call inside a transaction (42 `withChangeSet` call sites).
- No session-level `SET` anywhere (pg_dump-style `set_config(..., false)` included).
- No `COPY FROM STDIN`.
- A data-dir lock.
- A PG17 → PG18 compatibility pass.

## 6. Migration path for existing users (v1.x Homebrew PG17 → bundled PG17), as part of the 2.0 `npm run update`

Verified end to end on the sample database: `pg_dump -Fc` (brew 17.12) → `pg_restore --single-transaction --exit-on-error` into embedded PG17 exited 0. All 121 tables (16,694 rows) and all 25 sequences matched by count and content digest. Zero tsvector differences (same major).

1. Stop both LaunchAgents, as `update.mjs` already does.
2. Back up as today (`pg_dump -Fc` into `backups/` and its copy).
3. `initdb` the bundled cluster under the state folder and start `com.controlcenter.db`.
4. Precheck the source for constraint violations that a restore would reject: the exclusion predicates on `activity_entries` and `time_blocks`, plus FK orphans. On a hit, stop with a message; never switch.
5. `createdb control_center`, then `pg_restore --no-owner --no-privileges --single-transaction --exit-on-error` using the **bundled** binaries.
6. **Verify:**
   - Per table: `count(*)` and `md5(string_agg((to_jsonb(t) - <generated columns>)::text, '|' order by 1))`, with `TimeZone=UTC` on both sides. Exclude generated columns (`search_tsv` ×2, `scan_ledger_entries.covered`); they are recomputed and differ across majors.
   - `pg_sequences.last_value` for every sequence.
   - `drizzle.__drizzle_migrations` identical, then `runMigrations()` reports `match`.
   - Refuse to switch on any mismatch.
   - The spike's verifier took 4-12 s on the sample database.
7. Write `DATABASE_URL` (the socket URL) into the env file and start web and worker.
8. Leave the Homebrew database untouched for 14 days. Doctor reports it and gives the removal command.
9. Rollback: any failure before step 7 leaves the env file pointing at Homebrew, which is the existing `update.mjs` contract. Users who set `DATABASE_URL` themselves are left alone.

If PGlite (PG18) were the target instead, the measured path is different and worse:
- Use `pg_dump --inserts --rows-per-insert=200` (**not** the COPY format, which wedges the socket) → `psql -1 -f` through the socket. That took 1.4 s here and every non-generated column matched.
- 15 of 939 `source_items.search_tsv` values differ (PG18 stemming, e.g. `'ad'` vs `'add'`).
- The restore left `search_path = ''` for all later connections until reset.
- Backups would then need the WASM `pg_dump` (`@electric-sql/pglite-tools` 0.4.17 reports "pg_dump version 18.7", ran in-process in 1.2 s for a 9 MB dump, replay verified) or `dumpDataDir('gzip')` (4.7 s, 13.9 MB; `loadDataDir` 3.5 s). Both run inside the host process, because Homebrew's `pg_dump` 17 refuses a PG18 server.
- A file copy of the data dir taken while the host was killed reopened cleanly (crash-consistent), but there is no lock preventing a copy or a second open while it runs.

## 7. Risks (of the recommended path)

- **Lifecycle ownership**: a third LaunchAgent; crash recovery is Postgres's own. The embedded-postgres `stop()` path was clean (23-176 ms). Killing the Node wrapper leaves `postgres` running, so the agent should run `postgres` directly, not through a Node parent.
- **Install size**: 119 MB download / ~300 MB on disk per arch, against ~10 MB for PGlite. It fits the Drive-distributed build (H-12) but is the biggest artifact in it. The ICU dedupe would bring it to ~190 MB.
- **No pgvector** in the bundled binaries. R10 (local embeddings) needs a pgvector build added to the bundle ([postgres-vector-embedded](https://github.com/boomship/postgres-vector-embedded) or our own build), or it stays PGlite-only in tests.
- **Future major upgrades** (17 → 18): `pg_upgrade` or dump/restore with the same verifier. Generated tsvector columns will change, which is expected, not a mismatch.
- **embedded-postgres versions are `-beta.N`**: pin exact versions and check the binary hash in the installer (the same practice as H-13).
- **Socket path with a space** (not verified): see §4.

## 8. How to re-run (gate for a future PGlite revisit)

Scratch scripts are in the session scratchpad `spike/`:
- `host.mjs`: PGlite + socket host.
- `hostfix.mts` + `muxfix.ts`: the patched multiplexer.
- `migrate.mts`: the app's `runMigrations`.
- `tests.mts`: P1, session, (a)-(f), mixed.
- `queue2.mts`: `claimJobs`, 2 pools.
- `lost.mts`: minimal multiplexer repro.
- `bus.mts`: the app's `PgEventBus` across processes.
- `crash.mts`: kill -9 and reconnect.
- `dbl.mjs`: double open.
- `backup.mjs`: pglite-tools `pg_dump`, `dumpDataDir`/`loadDataDir`, replay.
- `verify.mts`: count + digest.
- `inproc.mts`: in-process PGlite with the app's queue.
- `epg/epg.mjs`: embedded-postgres lifecycle.

PGlite becomes eligible as the app DB again only when, **with the stock upstream package**:
- `queue2.mts` and `lost.mts` (K ≥ 5) pass.
- `bus.mts` receives every event.
- `tests.mts` shows `backendPids` distinct and `otherConnReadInsideOpenTx: served`.
- The `COPY` restore works.
