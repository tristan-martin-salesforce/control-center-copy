# Releasing Command Center

Command Center runs on each person's own Mac. When a teammate reports a bug, the first question is "which version are you on?", and the answer has to mean something. So every shared build has a [semantic version](https://semver.org/) (D-57), a changelog section, and a git tag.

## What each bump means

| Bump | When | What a teammate does |
|---|---|---|
| **major** (`2.0.0`) | A migration or settings reset that needs a **manual step**, or a **breaking change to the API contract** (`src/contract/**`: a route removed or renamed, a response field removed or retyped, a request field made required). | Reads the version's changelog section **before** updating, does the step it names, then runs `npm run update`. |
| **minor** (`1.3.0`) | New features, and **additive migrations that apply on their own** (new tables, new nullable columns, new settings fields with defaults). | `npm run update` whenever convenient. |
| **patch** (`1.2.1`) | Fixes only: no new features, no migration. | `npm run update`. |

Rules of thumb:
- A settings field added with a default is **minor**. Renaming or removing one, or a default that changes behavior someone relies on, is **major**.
- A migration that rewrites or deletes data, or needs `npm run db:migrate` plus something else (a rescan, a re-auth, a re-onboard), is **major**. Write the step in the changelog under the version heading.
- If in doubt between two bumps, take the bigger one.

## Cutting a release

From a clean `main`, with `npm run check` passing:

```bash
npm run release -- minor --dry      # preview the CHANGELOG section; changes nothing
npm run release -- minor            # bump, write CHANGELOG.md, commit, tag v1.3.0 (local only)
```

`npm run release -- patch|minor|major`:
1. Refuses a dirty working tree.
2. Bumps `package.json` and `package-lock.json`.
3. Writes the next `CHANGELOG.md` section:
   - It folds in the hand-written `## [Unreleased]` entries.
   - It adds the commit subjects since the last `v*` tag: `feat` → Added, `fix` → Fixed, `perf`/`refactor` → Changed, `type!:` → Changed (breaking). Merge, `chore`, `test`, `ci` and `build` commits are skipped.
   - For the first release (no tag yet), only the Unreleased entries go in. `--all` adds every commit; `--since <ref>` picks a start.
4. Commits `chore(release): vX.Y.Z` and creates the annotated tag `vX.Y.Z`.

It **never pushes**. Review the section. To reword it, amend the commit and move the tag (`git commit --amend`, then `git tag -fa vX.Y.Z`) before you push.

Commit subjects end up in a shared file. Keep them free of customer names, and run `npm run scan:private` before pushing.

## The 1.x -> 2.0 rename

2.0 renames the product (D-101): the state folder, the LaunchAgent labels and the database. A 1.x install migrates itself on its
first 2.0 start (`scripts/ops/lib/migrate-state.mjs`), from the installer, `npm run update`, or the 1.x updater's restart of the
old services on the new code, so one `npm run update` is enough from a source checkout. The 2.0.0 CHANGELOG section says so in
its first lines. Before cutting 2.0.0: run the migration against a copy of a 1.x install (a temp `HOME`, never the live
folder), `npm run doctor` after it, and `npm run scan:private`. Backups named `control_center-<stamp>` stay valid for restore.

## Changelog entries while you work

Every change that a teammate would notice gets a line under `## [Unreleased]` in `CHANGELOG.md`, under `### Added`, `### Changed`, `### Fixed` or `### Removed`. The release script keeps these hand-written lines ahead of the commit subjects. For a major change, say what the person has to do.

## How versions reach people

- **The build embeds** the version, the short git sha and the build time (`next.config.ts` → `CC_APP_VERSION`, `CC_GIT_SHA`, `CC_BUILT_AT`).
- **The worker** records its version in `worker_instances.app_version` when it starts.
- **`GET /api/v1/version`** returns `{version, sha, builtAt, migration, bundledMigration, persona, workerVersion, mismatch, migrationPending, dataSource}`. `mismatch` means the web app and the worker run different versions: one was restarted and the other wasn't.
- **The sidebar footer** shows `v1.3.0 · abc1234` and turns amber on a mismatch or a pending migration. Settings ▸ About shows everything plus a "Copy version line" button for bug reports.
- **`npm run update`** fetches, and for a major version prints its changelog sections and asks first (`--yes` answers). It then fast-forwards and stops both LaunchAgents (`com.commandcenter.web`, `com.commandcenter.worker`). It installs, builds (the previous build is kept until this one succeeds), backs up the database, moves a 1.x Homebrew database into the bundled cluster (D-98, verified; see "The database" below), migrates and starts both agents again. It prints `old → new` with the changelog sections in between. A failed install, build, backup or migration leaves the schema alone, puts the previous build back and starts the agents again (lane E, E1; `scripts/ops/lib/update.mjs`). Run from a checkout other than the one the installed agents run (their plist's `WorkingDirectory`), it refuses before changing anything: never run it from a lane worktree.
- **Migrations:** every new journal entry must have a newer `when` than the one before it, or drizzle skips it on every database that already migrated. `tests/ops/migrations-journal.test.ts` fails the merge otherwise, and also checks files, snapshots, numbering and the snapshot chain. `npm run db:migrate` fails on a skipped migration. `drizzle-kit generate` numbers from the journal's last `idx` (0023 after `0023_llm_audit`), so rename its output (SQL file, snapshot, journal tag) to the next free number and restore the snapshot it overwrote.
- **`GET /api/v1/version`** also carries, on a compiled install, `release` (`{version, channel, arch, builtAt}` from the build's manifest) and, once the worker has checked, `update` (`{available, version, notes, channel, publishedAt, checkedAt, error, prompt}`; D-90).

## Publishing a compiled release (D-90, H-12)

Teammates don't clone the repository: they install a **compiled build** from the team's shared Google Drive folder,
by asking Claude Code ([INSTALL.md](INSTALL.md)). No GitHub Releases, no hosting. You (Tristan) run:

```bash
npm run release -- minor --dry --publish   # the section and the publish plan; changes nothing (no bump, commit, tag, build or staging)
npm run release -- minor --publish         # scan:private → bump, CHANGELOG, commit, tag → build → feed → stage the two items
```

`--publish` adds, around the usual release:
1. **Before the bump:** `npm run scan:private`. Any hit, or a scan that can't run (it needs `DATABASE_URL`), refuses
   the release; nothing is bumped.
2. **After the commit and tag:** `npm run build:release -- --channel stable|beta` (below) builds
   `dist/command-center-<version>-<arch>.tgz` and its `.build.json` (size, sha256, timings).
3. **The feed:** `dist/releases/manifest.json` gets this version's row (version, channel, artifact, sha256, bytes, arch,
   node range, sha, migration head, the CHANGELOG section as notes, published_at, `drive_file_id`). Pass the folder's
   current copy with `--feed <path>` so older rows are kept (otherwise the last local `dist/releases/manifest.json`).
   `dist/releases/` then holds the three files to upload: the `.tgz`, `manifest.json`, `install.sh`.
4. **Two items for you, never sent by the script** (*Nothing leaves without approval*; `src/outbox/adapters/release-handoff.ts`),
   written to `dist/releases/outbox-<version>.json`, printed, and **created as two Outbox drafts in the running app**
   (`POST /outbox/releases`, `src/outbox/release.ts`):
   - **`release.drive_upload`: the upload to the Drive folder, a hand-off.** The app's Google access is devbar's
     `google_workspace_readonly` server, read tools only, and the allowlist is never widened (hard invariant 2). So
     nothing in Command Center can write to Drive, and this item has no tool call in any mode. Its row shows the
     version, the folder, the build's name and its sha256 (short; the full one in the expansion), with **Copy upload
     instructions** (the exact prompt for Claude Code: upload the three files to the folder, replacing `manifest.json`
     and `install.sh`, keeping older builds the feed lists; do it in your own session with your own Drive connector).
   - **`release.announce`: the Slack announcement draft** to `distribution.announceChannel`: the CHANGELOG section plus
     the install and update prompts, in the feedback post's `slack_send_message` shape (D-56).
   Idempotent per version: a second `--publish` of the same version updates the pending items in place (never a second
   pair) and leaves an applied one alone. **The app not running?** The file is the hand-over; start the app and run
   `npm run release:outbox -- dist/releases/outbox-<version>.json` (the same two drafts). `--no-app` writes the file
   only; `CC_APP_PORT` names another port than 4327.
5. It never pushes, uploads or posts.

**The Approve step (the Outbox, `/outbox`).** In this order:
1. On the upload row: **Copy upload instructions**, paste them into Claude Code (or drop the three files into the
   folder yourself), then **Mark uploaded**. That records the hand-off (the row moves to Sent as "Handed off", and a
   `record_landings` row of kind `release`, destination `drive`, keeps the version, folder and sha256). Nothing is sent.
2. On the announcement row: **Approve & send**. It previews the exact post, asks you to confirm, waits the undo window
   (Settings ▸ Sending) and then dispatches. With dry run on (the default) that only renders the payload; with dry run
   off the post goes through the same live relay as the feedback post, only to the configured announcement channel. A
   failed post comes back under Retry with a fresh preview and confirm. No channel set: the row says what to set and
   Approve is off.

Where it publishes: `distribution.driveFolderId` and `distribution.announceChannel` (settings), else
`config/team.json` (`distributionDriveFolderId`, `distributionAnnounceChannel`, `distributionAnnounceChannelName`), else
`CC_DISTRIBUTION_FOLDER_ID` / `CC_DISTRIBUTION_CHANNEL`, else `--folder` / `--announce`. Ids only.

**Channels:** `stable` (default) and `beta` (`--channel beta`, a `-beta.N` version). An install's update check offers
stable releases only, unless its `distribution.channel` is `beta` (then both).

### The build (`npm run build:release`)

`scripts/release/build.mjs`: `next build` with `CC_STANDALONE=1` (`output: 'standalone'` in `next.config.ts` only then,
so a source checkout's `npm run build` + `next start` is unchanged), then one folder `command-center-<version>/`.
It removes `.next` first and fails when no `.next/static/chunks` file carries the build's sha (ON-28: a stale cache
once shipped a client from an older sha, so every first page said "Command Center was updated"). The folder holds:
- Next's standalone server (`server.js`, `.next/`, only the production `node_modules` files it traces) plus
  `.next/static` and `public/` (never `public/fonts`: the Salesforce Sans fonts are licensed per person);
- the worker, the migrator and doctor bundled with esbuild (`esbuild.worker.mjs` → `dist/worker/index.mjs`,
  `dist/db/migrate.mjs`, `dist/ops/doctor.mjs`; no tsx at run time). Code that finds files next to its source
  (`import.meta.url`) resolves as it would at `<release>/src/…`;
- the packages the bundles load at run time, whole (pino, the Claude Agent SDK and its peers the MCP SDK and zod),
  **without** the SDK's 300 MB platform binary: the app runs the user's own `claude` CLI (`src/ops/claude-bin.ts`);
- data read at run time: `skills/`, `src/db/migrations/`, `config/`, `tools-registry/`, `src/mock/seed.example.json`;
  the ops scripts (`scripts/ops/**`, plain `.mjs`), `ops/launchd/`, `install.sh`, `docs/INSTALL.md`;
- the release's own `package.json` (no devDependencies; `start`, `worker`, `doctor`, `db:migrate`, `update`,
  `ops:install`, `ops:rollback` run the compiled entries);
- `manifest.json`: version, sha, dirty, channel, arch, node range (`>=20 <26`), `built_at`, migration head and the
  sha256 + size of every file.

It's a `.tgz` (gzip): macOS's own `tar` (bsdtar 3.5) has no zstd. `--smoke` unpacks the artifact into a temp folder
and runs it there (`scripts/release/smoke.mjs`): the web with mock data on 127.0.0.1:4361 (`/` and `/api/v1/version`
must answer, with the manifest's version), then the bundled migrator on a throwaway database and the bundled worker
with live scans off until it writes its heartbeat.

Measured on the maintainer's Mac (Apple Silicon, Node 25.4, a heavily loaded machine), 2026-11-20, v1.3.0:

| | |
|---|---|
| artifact | about 137 MB `.tgz`; about 449 MB and 13,600 files unpacked, of which the bundled Postgres engine is about 300 MB (2.0.0, 2026-11-21; v1.3.0 without the engine: 26.1 MB, 140 MB and 12,383 files) |
| build | 189 s total: `next build` 164 s, esbuild 0.9 s (worker 5.7 MB, migrator 0.6 MB, doctor 0.8 MB), tar 6.4 s |
| install checks | every file's sha256 verified in about 4.4 s |
| web startup | first `GET /` 200 about 2.3 s after `node scripts/ops/start-web.mjs` |
| worker | bundled migrator 7.4 s on an empty database; first heartbeat 0.6 s after start |

Every build writes its own numbers to `dist/command-center-<version>-<arch>.build.json`.

### Install, update and rollback of a compiled build

`scripts/ops/install.mjs` (and `install.sh`, which also checks Node and Claude Code first) installs a build as a whole
(PKG-2): sha256 against the feed (a build no feed lists is refused unless `--unverified`; `install.sh` without the
folder's `manifest.json` next to it unless `CC_INSTALL_UNVERIFIED=1`) → unpack → every file against the build's manifest → `ensureDatabase`
(`scripts/ops/lib/ensure-db.mjs`, D-98: Command Center's own Postgres 17 under `<state>/pg`: the engine copied once
per version, `initdb` once, the `com.commandcenter.db` LaunchAgent started, `command_center` created, the env file's
`DATABASE_URL` set to the socket URL; no Homebrew step) → env file → stop the web and worker agents → backup → (a
1.x install whose data is in Homebrew: the verified move below) → migrate with the **new** build's migrator → point `releases/current` at it (an atomic rename) → write both
LaunchAgents for `releases/current` → start them → wait for the new version on `/api/v1/version` → keep the last 3.
A failure before the switch leaves the old release running; a failure after it puts `current` back and restarts the
previous release (the database stays migrated, additively; the pre-migration backup is named). `npm run ops:rollback`
goes back on purpose. `npm run update -- --from <file.tgz>` runs the same steps for an update; `--from <folder id>`
prints the Claude Code prompt, because the app's Drive read path reads text (`get_drive_file_content` returns a file's
text content), not a binary build.

### The database: bundled Postgres 17, and the 1.x move (D-98)

The release carries `@embedded-postgres/darwin-<arch>` (pinned exactly, `17.12.0-beta.19`; the server only: initdb,
pg_ctl, postgres and their libraries). It adds about 300 MB unpacked to the release (the npm package materialises the
ICU symlinks as three copies; the installed engine copy under `<state>/pg/engine/` links them again: 144 MB) and about
110 MB to the `.tgz`. The build refuses to ship without it: before bundling, `scripts/release/build.mjs` checks the
package for this Mac's arch is installed with `initdb`, `pg_ctl` and `postgres` at the pinned version (`npm ci`
installs the optional dependency; `--allow-no-engine` builds without it on purpose and labels the release
`NO-ENGINE.txt`; `--check-engine` runs only the check), and the smoke prints which the unpacked release carries. Build from the main checkout, never from a worktree whose `node_modules` is a symlink: the traced copy balloons to about 300 MB and 60,000 files, so the build refuses that case too (ON-21, `20-onboarding-dry-run.md`).

A 1.x install keeps its data in Homebrew Postgres (`DATABASE_URL=postgresql://localhost:5432/command_center` in the
env file). Updating it to 2.0 moves the data into the bundled cluster, after the usual backup and before the new
migrator runs (`scripts/ops/lib/migrate-cluster.mjs`):

1. the bundled cluster: engine copy, `initdb` once, `com.commandcenter.db` running;
2. **precheck** the Homebrew database for what a restore would reject: every exclusion constraint (the overlap rules
   on `activity_entries` and `time_blocks`) and every foreign key, built from the catalog. A hit stops here with the
   constraint and the count: **nothing switches**, and the message asks for a report (the data needs a fix first);
3. `pg_dump -Fc` with Homebrew's 17 client tools (the bundle has none; the source is Homebrew's, so they are there);
4. `CREATE DATABASE command_center` on the bundled cluster, `pg_restore --no-owner --no-privileges
   --single-transaction --exit-on-error` over its socket;
5. **verify**, both sides with `TimeZone=UTC`: per table `count(*)` and an md5 over each row's `to_jsonb` minus the
   generated columns (`source_items.search_tsv`, `work_items.search_tsv`, `scan_ledger_entries.covered`), every
   `pg_sequences.last_value`, `drizzle.__drizzle_migrations` identical, then the migrator reports `match`. Any
   difference stops here: nothing switches;
6. **switch**: the env file's `DATABASE_URL` becomes the socket URL (the old line stays above it as a comment) and
   `CC_DB_ENGINE=bundled`; `<state>/pg/moved-from-homebrew.json` records when.

Any failure before 6 leaves the env file on Homebrew, the Homebrew database untouched, and the previous build running.
The Homebrew database stays untouched for 14 days; after that `npm run doctor` (`db-homebrew`) prints the removal
commands while it is still there. A `DATABASE_URL` you set (in the environment, or any value other than the 1.x
default in the env file) is never moved; `CC_DB_ENGINE=homebrew` in the env file, or `npm run update -- --keep-homebrew`,
keeps Homebrew on purpose.

**From a 1.x source checkout:** the 1.x updater that runs the first `npm run update` has no move step, so the first
update brings the 2.0 code (still on Homebrew, through the env file) and the **second** `npm run update` moves the
data. Doctor's `db-homebrew` says so in between (DEP.DB.MOVE_PENDING). Installing a 2.0 build (`install.sh`,
`npm run update -- --from <file.tgz>`) runs the new installer, so it moves in one go. Measured on the sample database
(128 tables, 16,677 rows): precheck 0.1 s, dump 0.3 s, restore 0.8 s, verify 1.2 s, about 2.5 s in all.

**Backups and restore on the bundled cluster.** The bundle has no `pg_dump`, so the nightly backup is an online base
backup with the server itself: `pg_backup_start` → a copy of the data folder → `pg_backup_stop` → the WAL in between
→ `backup_label`, tarred: `<state>/backups/command_center-<stamp>.base.tgz` (7.5 MB for the sample database). Kept 7
daily + 4 weekly, like the `.dump`s. `npm run restore` unpacks the newest one beside the live cluster and starts it on
its own socket to look at (it prints the URL and the stop command); `npm run restore -- --replace --yes`, with Command
Center stopped (`npm run ops:uninstall`), keeps the live data folder as `data.before-restore-<stamp>` and puts the
backup in its place; then `npm run ops:install`.

**A future major (17 → 18):** a new engine package major is refused against a 17 data folder (DEP.DB.MAJOR_MISMATCH,
nothing starts). It needs the same dump → restore → verify as the 1.x move, with the generated columns allowed to
differ (the stemmer changes); not built yet.

### The update check

The worker's `update.check` job (daily at 09:05, and **Check for updates**, `POST /api/v1/version/check-updates`) reads
the feed through the Drive connector's runtime with two read tools, both on the Google allowlist and the Drive
manifest (`RELEASE_FEED_READ_TOOLS`): `search_drive_files` (`'<folder>' in parents and name = 'manifest.json'`) and
`get_drive_file_content` (its text). It compares the feed with this build on the install's channel and writes
`update-check.json` in the state folder; `GET /version` turns it into `update`, and doctor's `update` check reports its
age. It downloads nothing and installs nothing.

## Before the first push to a remote

The repository had no remote while it was built, and its early history holds private material: customer names, Org62 ids, a work-order canvas, an owner fixture. Before connecting one:

1. Run `npm run scan:private`. It reads your real account, people and opportunity names from your local database. It checks every tracked file and every commit for those names, for Org62 and Slack ids your database knows, for id-shaped values and for salesforce.com emails. It prints **paths and counts only**.
2. If tracked files have hits, move them to `~/Library/Application Support/command-center/private/` or replace the values with placeholders. Then commit.
3. If **history** has hits, don't push this history. Push a fresh-history snapshot instead (README ▸ Sharing the repo).

**Placeholder-shaped ids are not hits.** The tests, eval cases, example seed and `sample-data/` hold thousands of id-shaped values, all made up, in a few fixed shapes a real id does not have: the sample kit's `SMPL` marker, `XX` in the Org62 instance characters, an 18-character Org62 id whose last three characters are not the case checksum Salesforce always writes, a placeholder word (TEST, MOCK, SEED, …), a typed run (ABCD, 0123), or a Slack id of letters then a zero-led counter. The scan counts those on one line ("Placeholder-shaped ids (not findings): N in M files"; `--show-placeholders` lists the files) and does not fail on them. Every other id-shaped value stays a hit, and an exact id your database holds is a hit whatever its shape, so the offline run (`--no-db --no-history`) now names only the few files worth a look; the DB-backed run is still the one to trust before a push. The shapes are in `placeholderShape` (`src/lib/private-scan.ts`); a new fixture should use one of them.
