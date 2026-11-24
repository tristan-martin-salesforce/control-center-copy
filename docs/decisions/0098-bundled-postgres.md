# D-98: Bundled Postgres 17 as the app database (2.0); the 1.x move is verified or nothing switches

- **Status:** Accepted, built (`p4-bundled-postgres`) · amends D-77 (its fallback is taken)
- **Date:** 2026-11-20
- **Source:** H-2; [12-pglite-spike](../reviews/2026-11-20-holistic/12-pglite-spike.md) (verdict NO: §1, §4-§7); H-11, H-12

## Context
D-77 made PGlite the app database if one shared connection held under the job queue and NOTIFY. The spike: it does not (stuck jobs, misrouted NOTIFY, a global lock per transaction, PG 18). The fallback is Postgres 17 the app manages itself, so a teammate never installs Homebrew Postgres ("out of the box"), and 1.x users on Homebrew move over on update.

## Decision
- **Engine:** `@embedded-postgres/darwin-arm64` and `-x64` pinned exactly at `17.12.0-beta.19`, as optional dependencies (the `embedded-postgres` wrapper is not used: we run the binaries ourselves). The package ships **the server only** (initdb, pg_ctl, postgres; contrib incl. pg_trgm, btree_gist; no pgvector, no pg_dump/psql/pg_isready). Size: 298 MB unpacked per arch (npm writes the ICU symlinks as three 55 MB copies), +~110 MB to the release `.tgz`; the installed engine copy under `<state>/pg/engine/<version>-<arch>/` links identical dylibs: 144 MB. The ICU dedupe inside the release itself needs `scripts/release/build.mjs` to stop dereferencing: not done.
- **Cluster:** `<state>/pg/data`, `initdb --locale=C --encoding=UTF8`, peer auth on the unix socket only; `listen_addresses = ''`, socket `<state>/pg/run`, `max_connections = 30`. A third LaunchAgent `com.commandcenter.db` (`com.controlcenter.db` before the D-101 rename) runs `postgres -D` itself (KeepAlive; no Node parent). Web and worker wait for its socket. A lock file (pid) serialises init/start/stop/move; Postgres's own `postmaster.pid` refuses a second server.
- **URL:** `resolveDatabaseUrl()` = environment `DATABASE_URL` → the env file's → the bundled socket URL. The installer writes the socket URL and `CC_DB_ENGINE=bundled`. A URL you set is never touched.
- **The 1.x move** (update and installer, after the backup): precheck the source (every exclusion constraint and FK, from the catalog) → `pg_dump -Fc` with Homebrew's 17 tools (the source is Homebrew's) → `pg_restore --single-transaction --exit-on-error` into the bundled cluster → verify (counts, row digests minus generated columns, sequences, drizzle migrations, the migrator says `match`) → switch the env file. Any failure switches nothing. Homebrew's copy is kept 14 days, then doctor gives the removal commands.
- **Backups:** the bundle has no pg_dump, so the bundled cluster gets online base backups (`pg_backup_start`/`_stop` + WAL, `.base.tgz`), restorable with the same binaries; 7 daily + 4 weekly.

## Consequences
- No Homebrew step for a teammate; one more LaunchAgent; the release grows by ~110 MB.
- A source checkout coming from 1.x runs `npm run update` twice (the 1.x updater has no move step).
- A future 17 → 18 needs a dump → verified restore (generated tsvectors will differ); a major mismatch refuses to start.
- pgvector (local embeddings) needs its own build added to the engine.

## Supersedes
Amends D-77: bundled Postgres 17 for users; PGlite only for tests and mock mode.
