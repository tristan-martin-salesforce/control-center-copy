# Upgrading from 1.x (Control Center) to 2.0 (Command Center)

For two readers: the teammate who upgrades, and the Claude Code agent that does it for them. Sections 1 to 6 are in
plain words; section 7 is the agent's runbook; section 8 lists what the code does not answer yet. Every claim cites the
code that does it (the 1.x code is `main` at `v1.3.0`, read with `git show main:<path>`). Where this page and the code
disagree, the code wins: fix this page.

**The short answer to "what has to happen":**

| Question | Answer |
|---|---|
| How many updates? | Two `npm run update`s for a 1.x source install on Homebrew Postgres (every 1.x install made by `npm run setup`). The first brings the 2.0 code, migrates the schema and renames the install; the second moves the data into Command Center's own database. One `install.sh` run does all of it for a 1.x install that switches to the compiled build. |
| Re-run the engine (projections)? | No. `PROJECTIONS_VERSION` is 10 in both 1.3.0 and 2.0.0, so the stored projection state stays valid and the worker carries on incrementally. |
| Rescan history because the scanner changed? | No. Fetch-then-interpret applies to reads from each scope's cursor onward; stored `source_items` are not reinterpreted, and nothing in 2.0 can reinterpret a window older than 24 hours (gap UPG-1). |
| Re-attribute items? | Open rows: nothing to run. Their suggestion is computed when the page reads them, by the new engine. Rows you approved or logged: never touched. |
| The database move? | Section 3, steps 4 and 5: dump, restore, verify every table, then switch. Nothing switches unless every table matches, and the Homebrew copy is kept for 14 days. |

## 1. Before you start

**What a 1.x install looks like** (from `git show main:scripts/ops/update.mjs:33`, `main:scripts/ops/lib/plist.mjs:7-8`,
`main:scripts/ops/setup.mjs:37`):

| | 1.x |
|---|---|
| Code | a git checkout (no compiled 1.x build was ever published: `install.sh` and `build:release` are new in 2.0) |
| State folder | 1.x: `~/Library/Application Support/control-center/` (env file `env`, `backups/`, `first-scan.json`) |
| Logs | 1.x: `~/Library/Logs/control-center/` |
| Services | two LaunchAgents, `com.controlcenter.web` and `com.controlcenter.worker`, each running `<checkout>/scripts/ops/run-service.mjs`. 1.x had no database agent |
| Database | Homebrew Postgres 17 on `localhost:5432`, database `control_center`; the env file says `DATABASE_URL=postgresql://localhost:5432/control_center` |
| Port | 4327 (unchanged in 2.0) |

**Check that this is what you have** (read-only):

```bash
ls ~/Library/LaunchAgents | grep -E 'com\.(control|command)center' ; ls -d ~/Library/Application\ Support/{control,command}-center 2>/dev/null ; curl -s localhost:4327/api/v1/version
```

A 1.x install shows the two `com.controlcenter.*` plists, only `control-center`, and `"version":"1.x.y"`.

**Back up first.** In the 1.x checkout: `npm run backup`. It writes `control_center-<date>-<time>.dump` into
`…/control-center/backups/` (the 1.x folder). The update takes its own backup too, but **copy this file somewhere outside the state
folder**: 2.0's retention (7 daily plus 4 weekly) also counts the 1.x dumps (`scripts/ops/lib/backup.mjs:113-120`), so
the last 1.x backup is pruned about five weeks after the upgrade. It is the only way back to 1.x (section 6).

**Disk and time.** The build needs about 1 GB free for `node_modules` and `.next`. The data move needs about twice the
database's size free while it runs (a dump plus the restored copy; the dump is deleted after the switch,
`scripts/ops/lib/migrate-cluster.mjs`). Each update takes 3 to 10 minutes, mostly `npm install` and `next build`.

**The app is down** from "stop" to "start" in each update: the 1.x updater stops both services before `npm install`
(`main:scripts/ops/lib/update.mjs:104-114`), so the install, the build, the backup and the migration all run with the
app stopped. Plan for about 10 minutes, twice.

**Stop everything else.** Don't run `npm run dev`, a second checkout's services or a second update at the same time.
The updater refuses when the LaunchAgents run another checkout (`scripts/ops/lib/update.mjs:70-74`). The checkout must
be clean (`git status` shows nothing): the 1.x updater only fast-forwards, and a local change stops it at "merge
failed. Nothing changed."

## 2. The three starting points

### (a) A 1.x source checkout, updated in place

Run both in the checkout the LaunchAgents run.

1. `npm run update -- --yes`
   This is the **1.x** updater: Node loaded it before the pull. 2.0 is a major version, so it prints the 2.0 changelog
   and asks "Update to v2.0.0 and migrate the database now?" (`main:scripts/ops/lib/update.mjs:82-90`). Outside a
   terminal (Claude Code) there is nothing to answer with, so pass `--yes`. Without it you get "Not updated. Nothing
   changed." It then pulls, stops the 1.x `com.controlcenter.web` and `.worker`, runs `npm install`, `npm run build`, the
   backup and `npm run db:migrate` (2.0's migrator, against Homebrew), and starts the old services. Success ends with
   `[update] v1.3.0 · … → v2.0.0 · …` and `running: v2.0.0`.
   The old services now start 2.0's `run-service.mjs`. It sees the 1.x folder, starts the rename in its own process
   and exits (`scripts/ops/run-service.mjs:39-51`). The rename is logged to
   `~/Library/Logs/command-center/migrate.log` (section 3, step 1). Within a minute the app answers again under
   `com.commandcenter.web` and `.worker`.
2. **Between the two updates** the app is 2.0 on the 2.0 schema, still reading Homebrew Postgres (now the database
   `command_center`). It works normally. `npm run doctor` warns `Homebrew copy: your data is still in Homebrew Postgres`
   (`DEP.DB.MOVE_PENDING`, fix `npm run update`; `src/ops/checks/db-cluster.ts:66`).
3. `npm run update`
   This is the 2.0 updater. The 1.x updater has no data-move step; the 2.0 one does (`scripts/ops/update.mjs:235-246`).
   With nothing new to pull it still runs the whole sequence: `npm ci`, build, backup, **move**, migrate, start
   (`scripts/ops/lib/update.mjs:176-209`). Success prints `[update] move: your data into Command Center's own database
   (Homebrew's copy is kept)`, then the precheck, dump, restore and verify lines, and then `switched: Command Center now
   runs on its own database. Homebrew's command_center is kept, untouched, for 14 days`, and finally
   `v2.0.0 · … → v2.0.0 · … (already up to date)`. Homebrew Postgres must be running
   (`brew services start postgresql@17`); otherwise the plan says `the database stays where it is for now: Postgres 17 is
   installed but not running.` and nothing moves (`scripts/ops/update.mjs:238-243`).
4. Optional: `npm run ops:install -- --yes`. The rename already writes the two services from 2.0's template (the web
   binds `-H 127.0.0.1`; migrate.log says `services rewritten for 2.0: web binds 127.0.0.1`; UPG-3, fixed). Only if
   it could not read an old plist does it copy it and say to run this; `npm run doctor` then FAILS `DEP.PORT.EXPOSED`
   with this fix line (`src/ops/checks/ports.ts`).
5. Verify (section 5).

To stay on Homebrew on purpose, run `npm run update -- --keep-homebrew`, or set `CC_DB_ENGINE=homebrew` in the env file
(`scripts/ops/update.mjs:239`, `scripts/ops/lib/pg.mjs:225`).

### (b) A 1.x install switching to the compiled build from Drive

No compiled 1.x build exists, so a teammate "on 1.x" has a source checkout. To move to the compiled build, follow
[INSTALL.md](INSTALL.md) "Install: paste this into Claude Code" on the 1.x Mac. **One run does everything**:
`install.mjs` runs the rename first (`scripts/ops/install.mjs:89`), and the release installer moves a Homebrew database
after its backup in the same run (`scripts/ops/lib/install-release.mjs:11-14`, `:354-365`). It then points the
`com.commandcenter.*` services at `releases/current`, which replaces the rewritten 1.x ones (the `-H 127.0.0.1` gap
does not apply). Success ends with `v2.0.0 … Open http://localhost:4327`. Later updates come from the Drive folder:
INSTALL.md "Updating". The old checkout can stay, but leave it alone: don't run `npm run update` or `ops:install`
there, or its services take over again.

### (c) The owner's path: a new internal repository, then the live 1.x install onto it

The 1.x install runs from checkout A (for example `~/Projects/control-center`). The new internal repository, seeded
from this code, is cloned to checkout B. The services must end up running B. `npm run update` in B refuses while the
services run A (`scripts/ops/lib/update.mjs:70-74`), so the order matters:

1. In A: `npm run backup`, then copy the dump out of the state folder (section 1).
2. In A: `npm run ops:uninstall -- --yes` (1.x: stops and removes `com.controlcenter.web` and `.worker`; data, logs
   and the env file stay; `main:scripts/ops/uninstall-agents.mjs`).
3. Clone the internal repository to B, then in B run `npm ci` and `npm run build`.
4. In B: `node scripts/ops/migrate-state.mjs --check` prints (1.x folder still there) `[migrate] migrate: …/control-center would move to
   …/command-center`.
5. In B: `node scripts/ops/migrate-state.mjs`. It moves the folder, the logs and the env file's paths, and renames the
   Homebrew database `control_center` to `command_center`. There are no plists to rewrite, because step 2 removed them.
   Ends with `done: Command Center now lives in …/command-center (database command_center)`.
6. In B: `npm run update -- --no-pull`. No services run, so it says so and carries on: `npm ci`, build, backup, the
   Homebrew move, migrate (section 2a step 3 lists the lines).
7. In B: `npm run ops:install -- --yes`. It writes `com.commandcenter.web` and `.worker` for **B**, with
   `-H 127.0.0.1` (`scripts/ops/lib/plist.mjs`), and starts them. The database agent `com.commandcenter.db` was written
   by step 6's move.
8. Verify (section 5). Keep A untouched until you have verified; it is your way back to 1.x.

**The env file** (`…/command-center/env`) is not in either checkout and is not copied: the rename edits it in place
(old paths to new, database name) and the move turns `DATABASE_URL` into a comment and adds `CC_DB_ENGINE=bundled`
(`scripts/ops/lib/migrate-cluster.mjs:1-17`). **A `DATABASE_URL` you set by hand** (any value that is not the 1.x
default `localhost:5432/control_center` with no password; `scripts/ops/lib/pg.mjs:194-204`) is honoured. The database is
not renamed ("DATABASE_URL is set by you (database …): left alone", `scripts/ops/lib/migrate-state.mjs:298`) and not
moved (`dbEngine` answers `user`, `scripts/ops/lib/pg.mjs:220-229`). The doctor's `Database address` row says `set by
you … never moved`.

## 3. What happens automatically, in order

| # | Step | Where | Log line on success |
|---|---|---|---|
| 1 | **State folder rename** (from the first 2.0 entry point that runs: `run-service.mjs`, `update`, `install`, `setup`, `doctor`, `backup`, `restore`, `ops:*`, `predev`, `preworker`) | `scripts/ops/lib/migrate-state.mjs:189-221` | `Command Center was renamed: moving …/control-center to …/command-center`, `stopping com.controlcenter.web`, `folder moved` |
| 2 | **Logs, env file, backup, services**: logs folder; the env file's paths; the newest 1.x backup linked into `backups/pre-2.0/` (out of retention, UPG-4); the web and worker plists rendered fresh from 2.0's template for the same checkout, node and port (web binds `127.0.0.1`, UPG-3; the db plist rewritten); the web and the worker started; old plists removed | `migrate-state.mjs` `finish()` | `logs moved to …`, `env file: the database socket path now points into the new folder`, `kept the last 1.x backup out of retention: …/backups/pre-2.0/…`, `wrote com.commandcenter.web.plist`, `services rewritten for 2.0: web binds 127.0.0.1`, `starting com.commandcenter.web`, `done: Command Center now lives in …` (also in `~/Library/Logs/command-center/migrate.log`) |
| 3 | **Database rename** `control_center` → `command_center` (only when the URL is the 1.x default or the bundled socket; ends the old sessions, then `ALTER DATABASE … RENAME`) | `migrate-state.mjs:295-314`, `migrate-state-real.mjs:22-36` | `database renamed: control_center -> command_center`; if it can't: `the database keeps its old name control_center for now (…); everything works as before, the next update tries again` |
| 4 | **Schema migrations 0027 to 0039** in one transaction (1.3.0 ends at 0026; there is no 0028) | `src/db/migrate.ts`, `src/db/migrations/` | `[update] migrate: npm run db:migrate`, then the migrator's own lines |
| 5 | **Homebrew → bundled cluster** (the second update, or the compiled install): start the bundled cluster, precheck every exclusion constraint and foreign key, `pg_dump -Fc`, `pg_restore --single-transaction`, verify every table (row count and an md5 over each row), sequences and the migration journal, then switch the env file and write `pg/moved-from-homebrew.json` | `scripts/ops/lib/migrate-cluster.mjs:1-17`, `:88-187` | `precheck: N exclusion constraints and M foreign keys hold`, `dumped the Homebrew database (… KB)`, `restored it into the bundled cluster (one transaction)`, `verify: …`, `switched: …` |
| 6 | **Worker first start** queues `hygiene.sweep` (after 60 s), `kv.backfill` (after 30 s), recovers interrupted work, drops stale scan plans and withdraws drafts of closed to-dos | `src/worker/index.ts:276-289` | worker log: `queueing …` only on failure; `jobs` rows `hygiene.sweep`, `kv.backfill` |
| 7 | **kv backfill** (0036's step 2): copies the side-car key/value data into the new columns and tables; idempotent, chunked by 500, resumable; readers fall back to the kv until it is done | `src/jobs/handlers/kv-backfill.ts:375-377`, [DATA-MIGRATIONS.md](DATA-MIGRATIONS.md) | `jobs.result` `state: done`; `npm run db:backfill -- --dry` prints `nothing to copy` |
| 8 | **Projections**: no rebuild. `PROJECTIONS_VERSION` is 10 in 1.3.0 (`main:src/projections/run.ts:102`) and in 2.0.0 (`src/projections/run.model.ts:46`), so the stored watermark (`cc.projections`) is kept (`src/server/datasource/db/store/projections.run.ts:93`) | none | none |

**The migrations, by kind** (`src/db/migrations/0027…0039`):

| Migration | Adds |
|---|---|
| 0027 `llm_calls_measurement` | 12 nullable columns on `llm_calls`, one foreign key |
| 0029 `normalize_drive_refs` | **not additive**: rewrites `source_item_refs` `drive:<id>` into `drive_file` rows (insert the twin, delete the old form; idempotent) |
| 0030 `spend_holds` | table `spend_holds` and 3 indexes |
| 0031 `closure_checks` | table `closure_checks` and 2 indexes |
| 0032 `attribution` | tables `attribution_outcomes`, `dc_suggestions`, `opp_engagement`; `mapping_rules.miss_count`, `last_miss_at` |
| 0033 `priority` | tables `priority_feedback`, `priority_rules`; columns on `priority_runs` and `priority_scores` |
| 0034 `use_case_candidates` | table `use_case_candidates` (with a trigram index) |
| 0035 `chat_memory` | table `chat_memory` |
| 0036 `sidecar_columns` | 8 tables (`need_decisions`, `canvas_row_overrides`, `data_backfills`, `mirror_reads`, `vdp_assets`, `vdp_members`, `vdp_use_cases`, `vdp_use_case_phases`), columns on `accounts`, `opportunities`, `activity_entries`, `vdp_records`, `work_items`, `specialist_forecasts`, `use_cases` (the `*_id15` ones generated), 12 indexes |
| 0037 `home_indexes` | index `drafts_owner_canvas_idx` |
| 0038 `memory_source` | `chat_memory.source_message_id` |
| 0039 `read_profile_indexes` | index `source_items_owner_first_seen_idx` |

Every migration except 0029 is additive. 0029 changes only how Drive file references are spelled, into the
`drive_file` form that 1.x's own joins already used (the comment at the top of the file). The 1.x build is held back
by the schema guard, not by 0029 (section 6).

## 4. What does NOT happen automatically, and whether it should

| Question | Answer | Command | Gap |
|---|---|---|---|
| Is stored history reinterpreted under the new scan mode (`CC_SCAN_MODE`, default `fti`, `src/scanner/runtime/mode.ts`)? | No. FTI changes only what one run does; "planning, cursors, coverage commit … unchanged" (`src/scanner/interpret/runner.ts:1-4`). Each scope continues from its 1.x cursor, so only new reads are interpreted the new way. The A/B gate measured the same closures as the agentic path on the golden set (CHANGELOG 2.0.0 "Fetch-then-interpret"), so there is no known reason to rescan. `CC_SCAN_MODE=agentic` in the env file restores the 1.x path. | Health ▸ Rescan reads one scope again, from its cursor and at most the last 24 h (`src/server/datasource/db/domains/health.ts:67-68`). Nothing reads an older window again. | UPG-1 |
| Is "the engine" (projections) re-run? | Not needed: same `PROJECTIONS_VERSION` (section 3, step 8). It keeps running every tick for changed items, the current week every 15 minutes, and pending weeks (`src/projections/run.ts:87-130`). | None to force a full rebuild. Changing `PROJECTIONS_VERSION` in code is the only way: the next tick re-projects every source item and the last five weeks (`run.ts:126-130`). | UPG-2 |
| Are open rows re-attributed? | Yes, on read, with no job. The suggestion on a To-log row and its Needs-you row is computed when the page reads it, by `rowAttribution` (`src/server/datasource/db/attribution.ts:473`). Learned rules start empty (0032 adds the tables), so the engine answers as 1.x did until you correct something (`src/engines/attribution/activity.ts:10-14`). DC suggestions come from the daily batch, or now with **Refresh** (`POST /attribution/dc-suggestions/refresh`). | none needed | none |
| Are logged rows re-attributed? | **Never.** The projections may rewrite only rows in engine statuses (`upcoming`, `needs_input`, `proposed`, `excluded`, `dropped`, and `logged` rows that mirror an Org62 Event, which follow Org62); anything approved or later, and dismissed rows, are the user's (`src/projections/activity.model.ts:12-13`). A column you edited is locked (`user_locked_fields`, `src/projections/run.model.ts:220`). | none | none |
| Do unapproved rows from past weeks get the new account mapping? | Only when the week is recomputed: when one of its source items changes, or for the current week. A proposed row from three weeks ago keeps the account 1.x gave it, but its opp suggestion is still the new engine's (the row above). | none | UPG-6 |
| Are open to-dos re-checked by the new resolution check, or re-ranked by Priority@2? | Both start in **watch only** (D-82, D-83): the nightly sweep and auto re-rank run in shadow and change nothing until you switch them (Settings ▸ Sending ▸ Closing items for you; Settings ▸ Budgets ▸ Models and ranking ▸ Ranking). This is by design, not a gap. | the Settings switches | none |

## 5. Verify

Run in the checkout (or `npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run …` for a
compiled install):

1. `node scripts/ops/migrate-state.mjs --check` prints `[migrate] none` (`scripts/ops/migrate-state.mjs:25`). `both`
   means both folders exist (section 6).
2. `npm run doctor`. A healthy upgraded install shows these rows ok:
   - **State folder** (after a 1.x move) `command-center (moved from control-center on <date>)` (`src/ops/checks/state.ts:34`). A
     warning `the database rename (control_center to command_center) was postponed` means run
     `node scripts/ops/migrate-state.mjs` again.
   - **Postgres 17** and **Database cluster** (`…/command-center/pg/data, yours, mode 700`). **Database address** says
     `Command Center's own database`.
   - **Homebrew copy** `moved N day(s) ago; Homebrew's command_center is kept, untouched, until <date>`. After 14 days
     it warns with the two commands that remove it (`src/ops/checks/db-cluster.ts:62-76`). Run them only when you
     want the space back.
   - **Migrations** match (latest `0039_read_profile_indexes`). **LaunchAgents** shows the three
     `com.commandcenter.*`. **Port** has no `DEP.PORT.EXPOSED`. **Worker heartbeat** is fresh.
     `data:kv-fallback` reads "nothing read from the kv side-car any more".
3. `npm run db:backfill -- --dry` prints `nothing to copy` for every user
   (`src/jobs/handlers/kv-backfill.ts:370`). Right after the first start it may still list counts; the job runs 30 s
   after the worker starts.
4. `curl -s localhost:4327/api/v1/version` (`src/contract/version.ts`): `version` `"2.0.0"`; `migration` equals
   `bundledMigration` (`"0039_read_profile_indexes"`); `migrationPending` `false`; `dataSource` `"db"`;
   `mismatch` `false`; `workerVersion` `"2.0.0"`; `instance` present (it identifies the folder the web runs from).
   `release` appears only for a compiled install.
5. **Health ▸ Setup**: every row green or explained. The State folder row is the doctor's; there is no "Command Center
   X is available" banner for the version you just installed. **Home** shows your to-dos, and **Activity ▸ To log**
   shows the same weeks and hours as before.
6. `ls ~/Library/LaunchAgents | grep -E 'com\.(control|command)center'` lists only `com.commandcenter.*`.

## 6. Rollback and recovery

- **A failed update needs none.** Each update stops at the failing step, puts the previous build back and starts the
  app again. A failed migration rolls back, because all pending migrations run in one transaction. A failed data move
  switches nothing: "your data stays in Homebrew Postgres, untouched … tried again on the next update"
  (`scripts/ops/lib/update.mjs:23-34`, `scripts/ops/lib/migrate-cluster.mjs:64-69`).
- **`npm run ops:rollback` does not apply.** It moves `releases/current` back between compiled releases
  (`scripts/ops/rollback.mjs:1-6`), and there is no compiled 1.x.
- **Going back to 1.x after a successful upgrade** takes a restore. The 1.x worker refuses a database whose journal is
  ahead of its own (`src/worker/schema-guard.ts`). By hand: stop the services (`npm run ops:uninstall -- --yes`); in
  the 1.x checkout (`git reset --keep <1.x sha>`, which the failed-update line prints; `npm install`; `npm run build`)
  restore the last 1.x dump into Homebrew with `pg_restore --clean` into `control_center`;
  rename the state folder back; install the 1.x services. The rename keeps that dump in
  `…/command-center/backups/pre-2.0/`, where retention never looks; `npm run restore -- --list` shows it and
  `npm run restore -- pre-2.0/<file>` restores it into a side database to inspect (UPG-4, fixed in b97b293; a later
  major update keeps its own pre-update backup in `backups/pre-<major>.0/` and names it in its summary). The full
  2.0 → 1.x path is still not rehearsed end to end.
  What you did in 2.0 since the upgrade is lost.
- **A half-finished rename** (laptop closed, crash): the marker `…/command-center/migration.json` has no
  `completedAt`. The next entry point finishes it, or run `node scripts/ops/migrate-state.mjs` (`migrate-state.mjs:9-12`).
  The doctor's State folder row says `the move to command-center is half done`.
- **The rename was blocked** (a 1.x service: `could not stop com.controlcenter.web; nothing was moved`, or `the database server of the
  old folder is still running`): run the `launchctl bootout gui/$UID/<label>` it names, then the update again
  (`migrate-state.mjs:200-211`).
- **The database could not be renamed** (a session that would not end, permissions): the old name stays, the env file
  keeps it, and everything works. `npm run update` and `npm run doctor` retry it (`migrate-state.mjs:166`,
  `:309-313`). If both `control_center` and `command_center` exist, neither is touched. Decide which one holds your
  data, then rename or drop by hand.
- **Both folders exist** (2.0 ran before the old folder could move): `command-center` is used, `control-center` is left
  exactly as it is, and nothing is merged or deleted (`migrate-state.mjs:160-163`). If `command-center` is empty and
  the data is in the 1.x `control-center`, stop the services, move `command-center` aside, then run
  `node scripts/ops/migrate-state.mjs`.
- **Restore from a dump**: `npm run restore` restores the newest backup into a new database for inspection;
  `npm run restore -- --into command_center --replace --yes` replaces the live one, with the services stopped first
  (`scripts/ops/restore.mjs:1-15`).
- **Logs**: `~/Library/Logs/command-center/` (`migrate.log` the rename, `web.log`, `worker.log`, `db.log`). Before the
  rename they are in the 1.x `~/Library/Logs/control-center/`. The update prints to the terminal only.

## 7. For the agent: the runbook

Run on the teammate's Mac, in order. Every step is one command and a success check. **Stop and report** at the first
step whose check fails; don't improvise a fix.

**Never:** push, or run `npm run release`; turn VDP autopilot on or change any Settings ▸ Sending switch; send, post or
apply anything in the Outbox; run anything against another user's data or another checkout's services; delete
the 1.x `~/Library/Application Support/control-center`, `command-center`, a backup or the Homebrew database; use `--force`,
`--no-backup` or `--allow-downgrade`; print the env file. Read-only `curl` to `localhost:4327` is fine.

Path (a), a 1.x source checkout (`$CO` is the folder in the 1.x plist's `WorkingDirectory`):

1. `grep -A1 WorkingDirectory ~/Library/LaunchAgents/com.controlcenter.web.plist` (the 1.x plist) names `$CO`. **Stop** if the file
   is missing and `com.commandcenter.web.plist` exists: the install is already 2.0, so go to step 14.
2. `cd "$CO" && git status --porcelain` prints nothing. **Stop** if it prints anything: ask the teammate.
3. `curl -s localhost:4327/api/v1/version` shows `"version":"1.`.
4. `df -h ~` shows at least 2 GB free.
5. `brew services list | grep postgresql@17` shows `started`. If not: `brew services start postgresql@17`.
6. `npm run backup` prints a `control_center-….dump`.
7. (the 1.x dump) `mkdir -p ~/Documents/command-center-pre-2.0 && cp ~/Library/Application\ Support/control-center/backups/control_center-*.dump ~/Documents/command-center-pre-2.0/`
   copies at least one file.
8. `npm run update -- --yes` ends with `→ v2.0.0`. **Stop** on `failed`: the app still runs 1.x, so report the line.
9. Wait up to 90 s, then `tail -20 ~/Library/Logs/command-center/migrate.log` shows `done: Command Center now lives in`.
10. `node scripts/ops/migrate-state.mjs --check` prints `[migrate] none`.
11. `curl -s localhost:4327/api/v1/version` shows `"version":"2.0.0"` and `"migrationPending":false`.
12. `npm run update` prints `switched: Command Center now runs on its own database` and ends `(already up to date)`.
    **Stop** on `move failed`: the data is safe in Homebrew, so report the precheck or verify lines.
13. `npm run ops:install -- --yes` writes and starts `com.commandcenter.web` and `.worker`.
14. `npm run doctor`: no `fail` rows. The State folder, Database address, Homebrew copy and Migrations rows read as in
    section 5. There is no `DEP.PORT.EXPOSED` and no `DEP.DB.MOVE_PENDING`.
15. Wait 60 s, then `npm run db:backfill -- --dry` prints `nothing to copy`.
16. `curl -s localhost:4327/api/v1/version` matches section 5, step 4.
17. `ls ~/Library/LaunchAgents | grep -E 'com\.(control|command)center'` lists only the three `com.commandcenter.*`.
18. Report: the old and new versions, the doctor summary line, the database (`command_center`, bundled), and where the
    pre-2.0 dump copy is. Say the Homebrew copy is kept 14 days and that removing it is the teammate's choice.

Path (b): follow INSTALL.md's prompt, then steps 14 to 18 with
`npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor`. Path (c): section 2c
steps 1 to 8, then steps 14 to 18 here.

## 8. Gaps and open decisions

| # | Gap | Recommendation |
|---|---|---|
| UPG-1 | Nothing re-reads stored history under the new scan mode, and Health ▸ Rescan reaches back at most 24 h (`health.ts:67`). No one has decided whether 1.x items need it. The A/B gate says the closures match, so the answer today is "no rescan". | Decide explicitly (an ADR line). If wanted, a `scan:reinterpret -- --since 30d` job in 2.0.x that re-runs only the interpret step over stored `source_items` (no new reads), dry by default, under the spend governor. |
| UPG-2 | No command forces a full projections rebuild; the only lever is bumping `PROJECTIONS_VERSION` in code. | A read-only plan plus `npm run projections:rebuild` (drops `cc.projections` for one user; the next tick rebuilds) for support cases. |
| UPG-3 | **Fixed in 5236c18.** The rename used to rewrite the 1.x plists, so the migrated web kept `next start -p 4327` with no `-H 127.0.0.1` (D-76). Now `finish()` renders the web and worker plists from 2.0's template (`renderServicePlist` → `plist.mjs renderAgent`) for the same checkout, node and port, and starts them through the launchctl seam; migrate.log says `services rewritten for 2.0: web binds 127.0.0.1`. An old plist it cannot read is copied as before, with a note to run `npm run ops:install -- --yes`. The doctor FAILS `DEP.PORT.EXPOSED` on a web plist without the bind. | Done. Rehearsed on a scratch `HOME` with a fake launchctl. |
| UPG-4 | **Partly fixed in b97b293.** The rename links the newest 1.x backup into `backups/pre-2.0/`; `npm run update` links its backup into `backups/pre-<major>.0/` on a major update and names it in the summary. Retention (`listBackups`, the nightly job) reads the top folder only, so neither is pruned; `npm run restore -- --list` lists them and accepts `pre-2.0/<file>`. `ops:rollback` still covers compiled releases only. | Write and rehearse a 2.0 → 1.x restore once on a scratch `HOME`. |
| UPG-5 | A Homebrew install needs a second `npm run update`, because the 1.x updater that runs the first has no move step. In between, only the doctor says so. | 2.0.1: after the rename, the 2.0 code queues the move (or the worker shows a Health ▸ Setup row with a Run button for it), so one update is enough. |
| UPG-6 | Unapproved rows from past weeks keep their 1.x account mapping until their week is recomputed. | Low impact: the opp suggestion is computed live. If wanted, queue one recompute of the last 5 weeks on the first 2.0 start (an engine-version marker in `cc.projections`). |
| UPG-7 | Moving the services to a new checkout (path c) has no command; it relies on `ops:uninstall` in A and `ops:install` in B, and the `elsewhere` guard blocks a shortcut. | Document it (done here). Optionally `npm run ops:install -- --adopt` in B, which takes over services that point at another checkout after a confirmation. |
| UPG-8 | **Fixed in 5236c18.** `migrate-state.mjs --check` now prints `database: will be renamed control_center → command_center` / `already command_center` / `left alone (DATABASE_URL set by hand)`, with `; will move from Homebrew to the bundled cluster on the next update` for a 1.x Homebrew database (`databasePlan`, the run's own URL detection and `dbEngine`); read-only. | Done. |
