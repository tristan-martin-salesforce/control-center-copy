# 20: Onboarding dry run (salvaged)

**Date:** 2026-11-21 · **Lane:** `post-onboarding-dry-run` (stopped after about seven hours with 26 files uncommitted and no report) · **Salvage:** `post-onboarding-salvage`

## What the lane set out to do
Walk a teammate's first install from start to finish against the built tarball, on a throwaway state folder: `scripts/ops/install.sh`, `install.mjs`, doctor, `npm run update` and the 1.x state move (D-101). It also owed SEC-12 and SEC-14 from [17-security-review.md](17-security-review.md), a doctor check on the heartbeat's `last_error_code`, the Specialist AE wording in `src/components/onboarding/steps.tsx`, and a note at `src/ops/doctor-service.ts:67`.

The lane left no notes, so the findings below come from the diff. Its code comments use the ids ON-2, ON-3, ON-6, ON-7, ON-11 and ON-12. There is no list of what those ids mean, so each one is described by what its code does.

## What the diff shows was walked and fixed
Everything below was kept. It merged cleanly onto `tmart2322/control-center-port-polish` and passes the checks under Verify.

### 1. One launchctl seam (commit `af96aea`)
- `scripts/ops/lib/launchctl.mjs:6` adds `launchctlBin(env)`, which returns `CC_LAUNCHCTL` or `/bin/launchctl`. Moving `CC_LAUNCH_AGENTS_DIR` to a scratch folder is not enough on its own: launchd knows each service by its label, so a real launchctl would still stop or start this Mac's real `com.commandcenter.*` agents.
- These scripts now call it: `install-agents.mjs`, `lib/db-agent.mjs`, `lib/migrate-state-real.mjs`, `update.mjs`, and also `lib/release-wiring.mjs` and `uninstall-agents.mjs` (both committed in group 3).

### 2. Doctor fixes a person can paste in a compiled release (commit `2796a56`)
- `src/ops/checks/types.ts:86` adds `isCompiledRelease`, which is true when `manifest.json` sits at the repo root.
- `types.ts:93` adds `npmRun`. In a compiled release it writes `npm --prefix "$HOME/…/releases/current" run <script>` and quotes the path, because Application Support has a space in it. Nobody's Terminal opens in that folder (ON-11). Every check now uses it in place of the bare `npm run …`: agents, agents-current, data, database, db-cluster, node, ports, release and state.
- `heartbeat.ts:7`: in a release, a stopped or unloaded worker gets `ops:install` as its fix, because `kickstart` cannot start an unloaded service (ON-12). `database.ts:25` adds the same fallback after `KICKSTART_DB`.
- `assets.ts:19`: a release ships no brand fonts, so having no fonts there now passes the check instead of raising a fault.
- `agents.ts:12` and `ports.ts:57` honour `CC_LAUNCHCTL`.

### 3. First-install walk fixes and SEC-14 (commit `2cb9011`)
**`install.sh`**
- Detects the chip (`:24`).
- With no argument, finds the newest build for this Mac next to the script (`:72`).
- Refuses a build made for the other chip and Safari's auto-unpacked `.tar` (`:84`).
- Reads every feed copy, including `manifest (1).json`, and reports ok, mismatch, unlisted or no feed (`:90`).
- Clears the quarantine flag before unpacking (`:120`).
- **SEC-14** (`:136`): the `paths.mjs` path is now passed as an argument instead of being written into the JS source. Checked with a state folder whose path contains a space.

**`install.mjs`**
- Gives a clear message when the build file is missing (`:78`).
- Uses `feedShaFor` (`:84`) and names the cause when no feed lists the build.
- On a repeat install of the same version, starts any agent that is stopped (`:164`, ON-7).

**`lib/install-release.mjs`**
- Plain step names in `STEP` (`:47`).
- A failed first install now says what is true: there was nothing earlier to go back to (`FIRST_INSTALL_WHY`, `:63` and `:196`, ON-6).
- The previous version comes from `state.json`, not from where `current` points (`:192`). `up_to_date` now also requires `current` to point at that version (`:283`, ON-7).
- A build made for the other chip is refused (`:273`).
- A handed-in unpacked build is copied, not moved, so the installer's own modules stay where Node looks for them (`:298`, ON-2).

**`lib/release-manifest.mjs`**
- `FEED_FILE_RE` (`:224`) and `feedShaFor` (`:241`) find the feed files next to a build, including the names a browser gives a second download.

**`lib/release-wiring.mjs`**
- A first install has no user yet, so `/version` returns a 500. If onboarding then answers `no_user`, the release counts as up (`:53`, `:73`, ON-3).
- `arch` is now passed in (`:89`).
- Quarantine is cleared before `tar` (`:104`).

**Other files**
- `lib/paths.mjs:44` adds `npmInCurrent`, the script-side twin of `npmRun`.
- `lib/update-from.mjs:30` now uses `feedShaFor`, with the same wording as the installer.
- `uninstall-agents.mjs:34`: without a TTY, it explains how to go ahead with `--yes` and how to start the app again.
- `lib/pg.mjs`: the message when the database engine is missing now explains what to do.
- Tests: the lane changed three messages without updating the tests that check them (`tests/ops/install-release.test.ts:237`, `tests/ops/update-from.test.ts:24,64`). The salvage changed those assertions to the new wording and made no other test changes.

## What was reverted and why
Nothing. Each group was coherent, could be explained by the brief, and passed once those three assertions were updated.

Two groups still touch files they don't own, because they were split by file and not by hunk. The launchctl hunks in `release-wiring.mjs` and `uninstall-agents.mjs` went into commit 3, not commit 1.

## Gaps in what was kept
- The new behaviour has no tests of its own: `feedShaFor`, `npmRun`/`npmInCurrent`, the arch refusal, the repeat-install start (ON-7), the first-run health check (ON-3), and copy instead of move (ON-2). The existing suites pass, but the [build brief](BUILD-BRIEF.md) requires a test for every behaviour change.
- No living doc was updated. `docs/INSTALL.md` should cover the `manifest (1).json` handling, the `.tar` advice and the `npm --prefix` commands.
- There is no evidence that the walk reached a running app on a throwaway state folder. The fixes look like they came from such a run, but none was recorded, so this does not count as validated (invariant 5).

## Remaining
| Item | State |
|---|---|
| SEC-14: install.sh interpolates a path into JS | **done** (`scripts/ops/install.sh:136`) |
| SEC-12: a build manifest's `version` becomes a folder name unchecked | **done** `df74398`: `isInstallableVersion` refuses a version that is not plain semver or that a path could use, and a build older than the installed one is refused unless `--allow-downgrade` (`install.mjs`, `update -- --from`; `install.sh` passes it through, `76a2bd4`). Tests in `tests/ops/install-release.test.ts` |
| Doctor check on the heartbeat's `last_error_code` | **done** `ffa0d5d`: `src/ops/checks/worker-error.ts` names the Health catalog entry and its fix (pasteable in a release); Health ▸ Setup's worker row shows it while the heartbeat is ok. Tests `tests/ops/doctor-worker-error.test.ts` |
| `src/components/onboarding/steps.tsx` Specialist AE wording | **done** `df2ae9c`: the Sources and Review asides say "activity logs and record updates" (no VDP words), the section is "Profile & hours"; the file is split into `steps.{head,profile,sources,review}.tsx` and lint has 0 warnings. The Getting started AE outcome ("Update your forecast notes") was already fixed in `src/guide` (`e666605`). Test `src/components/onboarding/__tests__/asides-copy.dom.test.ts` |
| Note at `src/ops/doctor-service.ts:67` | **done** `ffa0d5d`: the VDP row's why drops "(Solutions Engineers)" (29-persona-qa: moot, the row shows only with the VDP source) |
| "Database stopped" failure in the doctor wrapper | **open**: not in this follow-up's items |
| Tests for the kept behaviour | **done** `2d699c6`: `tests/ops/install-kept-behaviour.test.ts` (`feedShaFor`, `npmRun`/`npmInCurrent`, the chip refusal, ON-2, ON-3, ON-7; the ON-7 start moved into `startStopped`) |
| The INSTALL.md update | **done** `76a2bd4` |
| A recorded end-to-end walk | see §Walk (`post-install-walk`) |

## Verify (on the merged tree)
- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 1 warning (the `steps.tsx` line count, which predates this lane).
- `npx vitest run --project unit tests/ops tests/release tests/scripts tests/hygiene`: 43 files, 428 tests passed. Before the three assertions were updated, 3 failed.
- `npx vitest run --project ui src/components/onboarding`: no test files match.
- `bash -n scripts/ops/install.sh`: ok.

## Walk (2026-11-21, from the built tarball)

**Lane:** `post-install-walk` · **Tree:** `453ecaa` (includes the salvage merge `661a78d`) · **Mac:** arm64, Node 25.4 from Homebrew, no Homebrew Postgres on the teammate's PATH.

### Verdict
**A teammate following INSTALL.md with the tarball that is in `dist/` today (`command-center-2.0.0-arm64.tgz`, built at `22e2768`) does not get a running app.** At step 3.4 (`install.mjs`), every first install stops with a Node `ERR_MODULE_NOT_FOUND` stack trace (ON-13). Running it again fails the same way.

**A tarball rebuilt from `453ecaa` (with the salvage's ON-2 fix) does get a running app**: bundled Postgres in the state folder, database created and migrated (36/36), agents started, `/` lands on onboarding step 1, and doctor's fixes can be pasted. That holds on the default port. On the lane port it took one workaround (ON-14), and the first attempt failed at the health step. The repeat install, `npm run update -- --from` (up to date, and the full `--reinstall` path), `ops:install` and `ops:uninstall` all work.

**What to do before publishing:** rebuild the tarball from the main checkout at or after `453ecaa` (not from a worktree, see ON-21). Then fix ON-14 before anyone with `PORT` in their shell installs it.

### Setup (how the walk was isolated)
- A throwaway world under `/tmp/cc-walk-<n>/`: `HOME=<walk>/home`, so the state folder, logs and LaunchAgents all fell under it. The env was cleared with `env -i`; `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` (no Homebrew Postgres; `claude` not on the PATH, as for a teammate who has not installed it yet); `PORT=4435`.
- `CC_LAUNCHCTL=<walk>/bin/launchctl`: a fake that logs every call.
  - `bootstrap` spawns the plist's `ProgramArguments` detached, with its `EnvironmentVariables`, `WorkingDirectory` and log paths.
  - `print` answers like launchd: exit 0 with `state = running`, or 113 `Could not find service`.
  - `bootout` sends SIGTERM and waits.
  - `kickstart -k` restarts.
  - The real launchd, the real state folder and Homebrew Postgres were never touched.
- Download folder `~/Downloads/command-center/`: the tarball copied from `kraken/dist`, plus **`install.sh` extracted from the tarball** (it ships at the archive root, `command-center-2.0.0/install.sh`, as INSTALL.md says). There is no `dist/releases/manifest.json` (nothing has been published), so the walk wrote a release-feed `manifest.json` with the publisher's own `emptyFeed` + `feedEntry` + `upsertFeed` (`scripts/ops/lib/release-manifest.mjs`). Its sha256 matched `command-center-2.0.0-arm64.build.json`.

### Steps
| # | Command (as the teammate, via the wrapper) | Visible result (trimmed) | Pass |
|---|---|---|---|
| 1 | `bash ~/Downloads/command-center/install.sh ~/Downloads/command-center/command-center-2.0.0-arm64.tgz` (tarball `22e2768`) | `Node.js v25.4.0` · `Claude Code is not installed … The install goes on` · `sha256 matches the release feed` · `current release: none (first install from a build)` · `verified 13618 files of v2.0.0` · then `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/command-center-install.XXXX/command-center-2.0.0/scripts/ops/lib/db-agent.mjs' imported from …/ensure-db.mjs` · `the install stopped (the lines above say why and what to run).` It left `releases/2.0.0/` (moved there) with no `current`, no env file and no database. | **fail** (ON-13) |
| 1b | the same command again | identical stack trace | **fail** |
| 2 | `npm run build:release` in this worktree at `453ecaa`, then the same `install.sh` (identical to `scripts/ops/install.sh`) and the new `.tgz` with its own feed. The leftover `releases/2.0.0` from step 1 was kept. | `sha256 matches the release feed (manifest.json)` · `verified 60475 files` · `Command Center's database (Postgres 17) is running; created command_center.` · `backed up the database: command_center-…base.tgz` · `[db:migrate] command_center is up to date` · `started; waiting for v2.0.0 to answer…` · after 90 s: `Starting Command Center did not work (step: health). This is the first install, so there is no earlier version to go back to: Command Center is stopped. npm run doctor in the new release (releases/current in the state folder) says why…` The web log shows `Local: http://127.0.0.1:4327 … Ready in 134ms`: the plist said `PORT=4435`, the env file said `PORT=4327` and won, while the installer polled 4435. | **fail** (ON-14, ON-15) |
| 2b | Set `PORT=4435` in the throwaway env file, then ran the same `install.sh` again (the teammate's "run it again") | `database command_center exists` · backup · migrate · `v2.0.0 is running` · `installed v2.0.0. Open http://localhost:4327` (ON-16) · doctor: 19 ok, 2 warn, 2 failed, 8 skipped. The two failures are `claude CLI: not found` and `devbar not installed`: expected in the sandbox, and both name their fix. Then `Command Center is installed and running.` | **pass** |
| 2c | Bundled Postgres from the state folder? | launchctl log: `bootstrap gui/501 <walk>/home/Library/LaunchAgents/com.commandcenter.db.plist`. Doctor: `accepting connections on its socket (no TCP port)` · `Database folder: ~/Library/Application Support/command-center/pg/data, yours, mode 700` · `engine 17.12.0-beta.19` · `Migrations: 36/36 applied (0039_read_profile_indexes)` · `Database URL: Command Center's own database`. | **pass** |
| 2d | The agents start (fake) | `bootstrap … com.commandcenter.web.plist`, `… worker.plist`. The worker logs `started` and then `no user yet …; waiting` (no scans, no external calls). | **pass** |
| 2e | `curl 127.0.0.1:4435/api/v1/version` | **500** `{"error":{"code":"internal",…}}`; web.log: `CC_DATA=db: no user in this database` (ON-17) | **fail** (known, ON-3 works around it) |
| 2f | `curl …/api/v1/onboarding`, `GET /`, `GET /onboarding` | 200 `{"status":"not_started","reason":"no_user","step":"role"…}`. In headless Chromium, `/` redirects to `/onboarding`, which shows "Set up · Step 1 of 6 / Your role / Solutions Engineer · Specialist AE (Preview)" with no alerts (screenshot looked at). | **pass** |
| 2g | Doctor's fixes pasted literally: `npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor` and `… run ops:install` | Doctor runs (exit 1 only because of claude and devbar). `ops:install`: `LaunchAgents written for releases/current (v2.0.0) and started. Check with: npm --prefix "$HOME/…" run doctor` (bootout + bootstrap through the fake). The "what to do" lines are not all pasteable (ON-19). | **pass** (with ON-19) |
| 3 | `install.sh` again, same version, while it runs | `current release: 2.0.0` · `v2.0.0 is already the current release (--reinstall installs it again)` · doctor · `installed and running`. Doctor now warns `Worker heartbeat: stale: last beat 66 s ago … restart the worker` (ON-18). | **pass** |
| 3b | `npm --prefix "$HOME/…/releases/current" run update -- --from ~/Downloads/…/command-center-2.0.0-arm64.tgz` | `checking … against …/manifest.json` · `sha256 matches the release feed` · `verified 60475 files` · `v2.0.0 is already the current release`. It does not refuse inside a compiled release. (My first hand-made feed had no `schema`/`name`. `install.sh` accepted it and `update` rejected it, saying "no manifest.json … lists it" (ON-20).) | **pass** |
| 3c | the same with `--reinstall --yes` | `stopped web, worker` · `backed up the database` · `up to date` · `v2.0.0 is running` · `v2.0.0 → v2.0.0. Open http://localhost:4327` (bootout ×2, bootstrap ×2) | **pass** |
| 4 | `npm --prefix "$HOME/…/releases/current" run ops:uninstall -- --yes`, then `rm -rf` of the walk folder | `removed com.commandcenter.web / .worker / .db` · `Command Center is stopped … Your data, backups, settings and logs were kept.` · `To start it again: npm --prefix "$HOME/…" run ops:install`. No walk processes remain. `lsof -i :4435` and `lsof -i :4327` show nothing. No `command-center-install.*` temp folders are left. | **pass** |

**Disclosure:** in step 2, the walk's web listened on **127.0.0.1:4327** for about 90 s (16:04:31 to 16:06:02), because of ON-14. Port 4327 was free before and after, and nothing else was using it. That breaks the lane rule "never port 4327"; the walk did not choose it, the install did.

### Findings (continuing the ON- numbers)
- **ON-13 (blocker for publishing): the tarball in `kraken/dist` (`22e2768`) cannot be installed.** `install-release.mjs` *moves* the unpacked build into `releases/2.0.0`. The installer is still running from the temp folder, so its lazy `import()` of `scripts/ops/lib/db-agent.mjs` from `ensure-db.mjs` fails. This is ON-2, and the salvage's commit `2cb9011` fixes it (it copies instead, `lib/install-release.mjs:298`). The fix came after that build. Two follow-ups:
  - *Smallest fix:* rebuild the tarball from at least `453ecaa` before publishing. Add the missing ON-2 test: install from a `--from-dir` that the test then deletes, and expect the db step to run.
  - **ON-2 test added in `3bde476`** (`tests/release/build-linked-node-modules.test.ts`: the real `scripts/ops` in an unpacked tree, `installRelease` from it, and `db-agent.mjs` imported from that tree at the database step). The rebuild from the main checkout and the `install.sh:134` crash line are still open.
  - *Also:* the failure prints a raw stack trace under "the lines above say why". `install.sh:134`: when `install.mjs` exits with an uncaught error, add one plain line ("the installer crashed; send the lines above with Report").
- **ON-14 (high): `PORT` is read with opposite precedence in two places.** **Fixed in `df7711f`**: `effectiveEnv` / `servicePort` in `release-wiring.mjs` (the env file wins, read when used: the plist, the health poll, backup); `tests/ops/install-walk-fixes.test.ts` covers both orders.
  - `scripts/ops/run-service.mjs:92` starts the service with `{ ...process.env, ...fileEnv }`, so the env file wins over the plist.
  - `scripts/ops/lib/release-wiring.mjs:84` has `merged() = { ...fileEnv(), ...env }`, so the shell wins. Lines 120 and 135 use it for the plist's port and for the health poll.
  - `setup.mjs:45` always writes `PORT=4327` into the env file.
  - Result: a teammate with `PORT` set in their shell (common for developers, e.g. `PORT=3000` in `.zshrc`) gets a web on 4327 while the installer polls their `PORT`. A first install then ends in "Starting Command Center did not work (step: health) … Command Center is stopped", although it was up.
  - *Smallest fix:* `release-wiring.mjs:84`, `const merged = () => ({ ...env, ...fileEnv() });` (the env file wins, as at run time). Alternatively, take `PORT` only from the file at lines 120 and 135. Add a test with the shell's `PORT` ≠ the file's `PORT`.
- **ON-15 (medium): the first-install failure's next step can't be pasted.** **Fixed in `e4bf2a8`** (`firstInstallWhy(releasesDir)` uses `npmInCurrent('doctor')`). `scripts/ops/lib/install-release.mjs:62` `FIRST_LOOK` says "npm run doctor in the new release (releases/current in the state folder)". That is the ON-11 problem again. *Fix:* build the line with `npmInCurrent('doctor')` from `lib/paths.mjs:44`.
- **ON-16 (low): "Open http://localhost:4327" is hard-coded.** **Fixed in `e4bf2a8`**: install.sh, install.mjs and the update print the configured port; the doctor's LaunchAgents and port checks read it (`appPort`), and "web down" is a warning.
  - Where: `install.sh:146-147`, `install.mjs:178`, and the update's `v… → v…. Open http://localhost:4327`. Doctor's `agents.ts:16-17` and the port check use `APP_PORT` and ignore the env file's `PORT`.
  - Impact: none on a default install. It is wrong for any other port: the doctor printed `Port 4327: free (nothing is listening)` and `✓ LaunchAgents: installed and loaded; web :4327 down` while the web was up on 4435.
  - A second problem: that check stays **✓ ok while it says "web … down"**. *Fix:* `agents.ts:17` should warn when `!webUp`, and read the port from the env file (the value the web actually runs with, ON-14).
- **ON-17 (low): `GET /api/v1/version` returns 500 until onboarding has made a user** (**fixed in `acbad8c`, moved into `versionSettings` in `6d0eeba`**: no user → the default persona, same shape; `tests/server/version-no-user.test.ts`) (`CC_DATA=db: no user in this database`). The installer works around it (ON-3), but other tools hit it: `npm run shot` refuses a fresh install ("no dev server answering … (HTTP 500)"), and any monitor that probes `/version` will too. *Fix:* the version route should not need a user (it reports the build, not the user's data).
- **ON-18 (low): the worker's heartbeat goes stale while it waits for onboarding.** **Fixed in `4f03739`** (`waitForUser`, in `src/ops/user-wait.ts` since `6d0eeba`, beats every 15 s; fake-clock test in `tests/worker/user-wait.test.ts`). Look at `src/worker/index.ts:221-224`: the loop logs "no user yet" and sleeps 60 s, and there was no beat between the start and doctor's check 66 s later. So any doctor run more than a minute after install, before onboarding, warns "stale … restart the worker". *Fix:* call `hb.beat()` (state `waiting`) inside that loop, or let the heartbeat timer start before the user wait.
- **ON-19 (low): doctor's "what to do" lines are not all pasteable.** **Fixed in `e4bf2a8`**: `formatReport` runs every catalog step through `pasteableStep` with the doctor's context (the catalog text is unchanged), and the stale heartbeat names the restart command.
  - `src/errors/catalog.ts:93-94` (`DEP.NODE.TOO_OLD`, `DEP.NODE.UNTESTED`) still say `npm run ops:install`, while the `fix:` line above them is the pasteable `npm --prefix "$HOME/…"` form.
  - `heartbeat.ts:23` says "restart the worker" without giving a command.
- **ON-20 (low): `install.sh` and `update --from` disagree about what counts as a feed.** **Fixed in `f6c39d8`**: install.sh applies parseFeed's checks (one test runs its inline program against parseFeed), and `feedRefusal` names the file and what is wrong.
  - `install.sh:90-104` accepts any JSON with a matching `releases[]` row.
  - `parseFeed` (`release-manifest.mjs:166`, used by `update --from` and `install.mjs`) also requires `schema: 1` and `name: "command-center"`. When those are missing, the message is "no manifest.json … lists it", which is false: the file is there, it just is not a valid feed.
  - The publisher always writes both fields, so only a hand-made or truncated feed hits this. *Fix:* `feedShaFor` should report "not a Command Center release feed" separately. Optionally, `install.sh` can check the same two fields.
- **ON-21 (release hygiene): build releases only from the main checkout.** **Fixed in `3bde476`** (`build.mjs` refuses a symlinked `node_modules` and names the fix; `docs/RELEASING.md` is not in this lane's files).
  - What happened: `npm run build:release` in a worktree whose `node_modules` is a symlink produced **302.5 MB / 1027 MB unpacked / 60475 files**. The `kraken` build was 137 MB / 13618 files. The worktree build still installed and ran.
  - Likely cause: the standalone file trace follows the symlink and copies far more files.
  - *Fix:* `scripts/release/build.mjs` should refuse (or warn) when `node_modules` is a symlink, and `docs/RELEASING.md` should say "build from the main checkout".
- **ON-22 (low): `ops:install` in a release says "started" without checking.** **Fixed in `0ee3169`** (`restartAgents` waits for the version; on failure the plain line and the doctor command). `scripts/ops/install.mjs:124-127` starts both agents and does not wait for health (`deps.health`). *Fix:* call `await deps.health(m.version)` and say the result.

### What passed (no action)
- The sha256 check against the feed.
- Every file checked against the build's manifest.
- Postgres 17 bundled in `<state>/pg`, reached through its socket only (no TCP port).
- The database created and migrated, and the backup taken before the migration.
- `releases/current` switched.
- The agents written and linted for `releases/current`.
- Onboarding reached from `/`.
- The repeat install of the same version.
- `update --from` with the same version, including `--reinstall`.
- `ops:install` and `ops:uninstall`, which keep the data and print the restart command.
- No temp folders left behind.
- The worker made no scans and no outbound calls before onboarding.

### Not covered
- The real `launchd`: KeepAlive, `ThrottleInterval`, and login start.
- An Intel build.
- Moving a 1.x Homebrew database or the 1.x state folder (D-101).
- A teammate machine without Homebrew Node: `install.sh`'s `brew install node@22` branch.
- The Claude Code half: downloading from Drive and the prompt's own sha256 check.
- Onboarding past step 1.

## Walk 2 (2026-11-21, after the fixes, tarball 10dcfc2)

**Verdict: a teammate following INSTALL.md gets a running app: yes** (on the default port). With `PORT` set in the shell, the app still runs, but on 4327 and not on their port (ON-23).

### Setup
- Tarball: `kraken/dist/command-center-2.0.0-arm64.tgz`, sha256 `27a87d12…49a` (matches `build.json`), 13,619 files, engine bundled (`17.12.0-beta.19`).
  - `build.json` and `/api/v1/version` say `sha: 61b47ff`. That is the main checkout's ledger commit on top of `10dcfc2`.
- Throwaway world `/tmp/cc-walk2-<n>/`, deleted at the end. The env was cleared (`env -i`) and set to:
  - `HOME=<walk>/home`, so the state folder, logs and LaunchAgents all fell under it
  - `PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` (no Homebrew Postgres; `claude` not installed)
  - `PORT=4439`
  - `CC_LAUNCHCTL=<walk>/bin/launchctl`, walk 1's fake: it logs every call and really spawns and stops each plist's program
- Download folder: `~/Downloads/command-center/` with the tarball, `install.sh` taken from the tarball root, and a release-feed `manifest.json` made with the publisher's `emptyFeed` + `feedEntry` + `upsertFeed`.
- A watcher logged every listener on 4327 once a second through the whole walk.
- The real state folder, the real LaunchAgents, Homebrew Postgres and the real launchd were never touched. No `~/Library/Application Support/command-center/` exists on this Mac.

### Steps
| # | Command (as the teammate) | Visible result (trimmed) | Pass |
|---|---|---|---|
| 1 | `PORT=4439` in the shell, no env file: `bash ~/Downloads/command-center/install.sh ~/Downloads/command-center/command-center-2.0.0-arm64.tgz` | `sha256 matches the release feed (manifest.json)` · `current release: none` · `verified 13619 files of v2.0.0` · `database (Postgres 17) is running; created command_center` · `backed up the database` · `up to date` · `started; waiting for v2.0.0 to answer…` · `v2.0.0 is running` · `installed v2.0.0. Open http://localhost:4327` · doctor 21 ok / 2 warn / 2 failed (claude, devbar: expected) · `Open http://localhost:4327` · `Getting started (first run): http://localhost:4327/onboarding`. Exit 0. The env file says `PORT=4327`, and so does the plist. | ON-22 **pass** (it waits for the version, then says "running"). ON-14 **pass** (the poll and the web agree). ON-16 **pass** (the printed port is the one it runs on). The shell's `PORT=4439` was ignored, **finding ON-23** |
| 1-disclosure | — | **The walk's web listened on 127.0.0.1:4327 from 16:31:54 to 16:32:03 (about 9 s)**, pid 76252 (`next-server`, from `<walk>/home/…/releases/current`). It was killed as soon as it was seen. 4327 was free before; nothing else was using it. Then I set `PORT=4439` in the throwaway env file and ran `launchctl kickstart -k …web` (the fake). From then on the web was on 4439 only, and the watcher saw nothing on 4327 for the rest of the walk. | see ON-23 |
| 1b | `curl 127.0.0.1:4439/api/v1/version`, `…/api/v1/onboarding`, `GET /`, `GET /onboarding` (no user yet) | `/version` **200** `{"version":"2.0.0","sha":"61b47ff",…,"persona":{"id":"se",…},"mismatch":false…}`. `/onboarding` API 200 `{"status":"not_started","reason":"no_user","step":"role"…}`. `GET /` 200 and `/onboarding` 200, but both render on the client, so curl sees only the shell ("Set up"). | ON-17 **pass**. Step 1 in a browser: **not re-verified** (1c) |
| 1c | `npm run shot -- / --port 4439` | `no dev server answering at http://localhost:4439 (HTTP 500)`. `GET /api/v1/health` gives **500**; web.log: `CC_DATA=db: no user in this database; set it up: npm run db:bootstrap (or npm run setup)` | **fail**, ON-24 |
| 2 | `npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor`, pasted literally, at about 50 s and at about 80 s after the worker started | `✓ Port 4439: the web agent (pid …) on 127.0.0.1:4439` · `✓ LaunchAgents: installed and loaded; web :4439 up` · `✓ Worker heartbeat: starting, beat 11 s ago`, then `beat 5 s ago` (the worker is still in the no-user wait). Every `fix:` and `what to do:` line that names a command uses the pasteable `npm --prefix "$HOME/…"` form, including `DEP.NODE.UNTESTED`. No ✓ line says down. Exit 1, only because of claude and devbar. | ON-18 **pass** · ON-15/19 **pass** · ON-16 **pass** |
| 3a | Step 1's command again, same tarball | `current release: 2.0.0` · `verified 13619 files` · `v2.0.0 is already the current release (--reinstall installs it again)` · doctor · `Open http://localhost:4439`. Exit 0. | **pass**; the hint is not usable through install.sh, **ON-25** |
| 3b | An unpacked copy with only `manifest.json` edited to `"version": "1.9.0"`: `bash ~/Downloads/old/command-center-2.0.0/install.sh` | `verified 13619 files of v1.9.0` · `this build is v1.9.0 and you run v2.0.0, which is newer` · `Checking the build's version did not work (step: downgrade). Nothing changed … run the same command with --allow-downgrade` · `back to the version you ran before: npm --prefix "$HOME/…" run ops:rollback` · `this older build anyway: the same command with --allow-downgrade`. Exit 1. | SEC-12 **pass** (the rollback line points at a release that does not exist, **ON-26**) |
| 3c | The same command with `--allow-downgrade` | `installing v1.9.0 over the newer v2.0.0 (--allow-downgrade)` · `stopped web, worker` · `backed up the database` · `started; waiting for v1.9.0 to answer…`, then after 90 s `current points at 2.0.0 again …` · `Starting Command Center did not work (step: health). The previous release is back in place and running.` Exit 1. Afterwards 4439 answered `version 2.0.0`. | **pass as a rollback test**. The flag is accepted and goes past the refusal. Health had to fail, because the version is compiled into the build: `/version` says 2.0.0 while only `manifest.json` says 1.9.0, and `release-wiring.mjs:70` waits for the exact version. The rollback did restore 2.0.0 and it ran; see ON-27. |
| 4 | A copy of the feed with `"schema": 2`, next to the same tarball: `bash ~/Downloads/badfeed/install.sh ~/Downloads/badfeed/command-center-2.0.0-arm64.tgz` | `manifest.json (next to command-center-2.0.0-arm64.tgz) can't be used: not a Command Center release feed (schema is 2, not 1). Download manifest.json again from the same Drive folder into …/badfeed, then run this again. Nothing changed.` Exit 1. | ON-20 **pass** |
| 5 | `npm --prefix "$HOME/…/releases/current" run ops:uninstall -- --yes`, then `rm -rf` of the walk folder | `removed com.commandcenter.web / .worker / .db` · `Command Center is stopped and will not start at login. Your data, backups, settings and logs were kept.` · `To start it again: npm --prefix "$HOME/…" run ops:install`. No walk processes remain (postgres included). `lsof -i :4439` and `lsof -i :4327` show nothing. No `command-center-install.*` temp folders are left. | **pass** |

### Findings (continuing the ON- numbers)
- **ON-23 (medium): a first install ignores the shell's `PORT` and always runs on 4327.** **Fixed** in `2766f58`: a new env file gets the shell's `PORT` when it is a valid port (`templatePort`), then the file wins. `/version` now carries `instance` (sha256 of the folder the web runs from), and the health poll stops at once with `another app answers on port <p>, not this install's web: see what holds it with lsof -i :<p>…` when the answer is not this install's.
  - *What happens:* `scripts/ops/setup.mjs:45` writes `PORT=4327` into the new env file. Since ON-14, the env file wins everywhere (`release-wiring.mjs` `servicePort`), so the plist, the web and the health poll all use 4327, consistently.
  - *Who it hurts:* a teammate with `PORT` exported gets their own port ignored without being told. Any scratch or lane install, this walk included, binds 4327 for real.
  - *Worse case (not seen here, read from the code):* when another app already answers on 4327 with the same version, the new web cannot bind. The poll (`release-wiring.mjs:70`) still sees the other app's `version` and reports `v2.0.0 is running`.
  - *Smallest fix:* setup.mjs:45 writes `PORT=${/^\d+$/.test(env.PORT ?? '') ? env.PORT : 4327}` (only when it creates the file). Test: first install with the shell's `PORT=4439` and no env file → the env file says 4439 and the poll uses 4439.
  - *Optional:* the health poll could also check that the pid answering is the agent's.
- **ON-24 (low): `GET /api/v1/health` still returns 500 before a user.** ON-17 fixed only `/version`. **Fixed** in `cc1c734`: `/health` answers the declared shape with `reason: 'no_user'` (`src/server/health-no-user.ts`); the ctx message says `finish Getting started at http://localhost:<port>/onboarding`; `npm run shot` says so and goes on.
  - The cause is `src/server/datasource/db/ctx.ts:100`, which throws "no user in this database".
  - Effects: `npm run shot` refuses a fresh install, since it probes `/health` (`scripts/shot.mjs:68`), and any monitor that probes `/health` gets 500 until onboarding is done.
  - The message's next step, `npm run db:bootstrap (or npm run setup)`, is not pasteable in a release (ON-11) and is the wrong advice there: onboarding makes the user.
  - *Smallest fix:* `/health` answers with the no-user state, as `versionSettings` does since `6d0eeba`. Separately, change the ctx.ts:100 text to "finish onboarding at http://localhost:<port>/onboarding".
- **ON-25 (low): the `--reinstall` hint can't be followed through `install.sh`.** **Fixed** in `c08eafc`: install.sh takes `--reinstall` and passes it on; the hint reads `run the same command with --reinstall to install it again`.
  - `scripts/ops/lib/install-release.mjs:318` says `v2.0.0 is already the current release (--reinstall installs it again)`.
  - `scripts/ops/install.sh:32` dies on any option except `--allow-downgrade` ("unknown option --reinstall").
  - *Smallest fix:* in install.sh, accept `--reinstall` next to `--allow-downgrade` and pass it to `install.mjs`. Otherwise, make the hint name a command that works: `npm --prefix "$HOME/…" run update -- --from <tgz> --reinstall`.
- **ON-26 (low): the downgrade refusal offers `ops:rollback` when there is nothing to roll back to.** **Fixed** in `aa23472`: the line (and the refusal's rollback sentence) only when `state.json`'s history names an earlier release still installed.
  - Where: `install-release.mjs:39` and `install.mjs:165` print "back to the version you ran before: … ops:rollback" unconditionally. In this walk, 2.0.0 was the only release ever installed.
  - *Smallest fix:* print that line only when `state.json` has a previous release (the check `ops:rollback` makes).
- **ON-27 (low): after a failed health check, "The previous release is back in place and running" is printed without checking.** **Fixed** in `aa23472`: the rollback calls `deps.health(previous)`; when it does not answer the line says so and names the doctor command.
  - Where: `install-release.mjs:46-47`. The text is fixed, and in the fake launchctl's log the bootstrap and the message came in the same second.
  - It happened to be true here: 4439 answered 2.0.0 a few seconds later.
  - *Smallest fix:* after the rollback's restart, call `deps.health(previousVersion)` (as ON-22 did for `ops:install`). Say "running" only when it answers; otherwise print the doctor command.

### Fixed findings re-checked
- **Pass:** ON-14, ON-15, ON-16, ON-17 (`/version`), ON-18, ON-19, ON-20, ON-22, SEC-12.
- **Not re-checked:** ON-13 and ON-21, which are build-side. This tarball installs, and it is 13,619 files / 137 MB, built from the main checkout.

### Not covered (beyond walk 1's list)
- A browser look at `/` → onboarding step 1 (ON-24 blocked `npm run shot`; curl sees only the client shell).
- A real downgrade to a build that was compiled as an older version.

## Walk 3 (2026-11-21, tarball ab6eb8da, after ON-23..27)

**Verdict: a teammate following INSTALL.md gets a running app, with `PORT` set in the shell: yes.** It runs on their port, and nothing listens on 4327. Three new problems showed up. The first page shows a false "Command Center was updated" toast (ON-28). Clean restarts count toward the worker's crash loop, and the doctor then reports the loop as a schema mismatch (ON-30). The install accepts a foreign app on its port when that app answers with no `instance` (ON-29).

### Setup
- Tarball: `kraken/dist/command-center-2.0.0-arm64.tgz`, sha256 `ab6eb8da…5597`, 144,147,494 bytes, 13,619 files verified. The server reports `sha: a4ed1e2`.
- Throwaway world `/tmp/cc-walk3-<random>/`, deleted at the end. Every step ran from a small script through walk 2's wrapper (`env -i`) with:
  - `HOME=<walk>/home`
  - `PORT=4444`
  - `CC_LAUNCHCTL=<walk>/bin/launchctl` (walk 1's fake)
  - a `PATH` whose only extra folder holds symlinks to `node`, `npm` and `npx`. `/opt/homebrew/bin` holds Homebrew's `pg_ctl`, `initdb` and `postgres-17`, so this walk left it out, unlike walk 2. The bundled engine was used.
- Download folder `~/Downloads/command-center/` held the tarball, `install.sh` from the tarball root, and a feed `manifest.json` made with walk 1's `mkfeed.mjs`.
- A watcher checked for listeners on 4327 once a second for the whole walk. **It saw nothing.** The real state folder, the real LaunchAgents, Homebrew Postgres (running on 5432 the whole time) and 4327 were never touched.
- Scripts and logs are kept in the session scratchpad under `walk3/`.

### Steps
| # | Command (as the teammate) | Visible result (trimmed) | Pass |
|---|---|---|---|
| 1 | `PORT=4444` exported, no env file: `bash ~/Downloads/command-center/install.sh ~/Downloads/command-center/command-center-2.0.0-arm64.tgz` | `sha256 matches the release feed` · `current release: none` · `verified 13619 files of v2.0.0` · `created command_center` · `backed up the database` · `started; waiting for v2.0.0 to answer…` · `v2.0.0 is running` · `installed v2.0.0. Open http://localhost:4444` · doctor `21 ok, 2 warnings, 2 failed` (claude and devbar are missing, as expected) · `Getting started (first run): http://localhost:4444/onboarding`. Exit 0. The env file has `PORT=4444` (mode 600), and so does the web plist. `lsof` shows node on 127.0.0.1:4444 and nothing on 4327. | ON-23 **pass**. ON-22 **pass** ("running" comes after "waiting"). ON-16 **pass** |
| 1b | `curl` of `/api/v1/version`, `/api/v1/health`, `/api/v1/onboarding`, `/` and `/onboarding` on 4444 | `/version` **200**: `{"version":"2.0.0","sha":"a4ed1e2",…,"instance":"24fa78dc29db9c70"}`. `/health` **200**: `{…"worker":{"alive":true,…},"dryRun":true,"reason":"no_user"}`. `/onboarding` 200: `status: not_started`, `step: role`. `/` and `/onboarding` both return 200 with the client shell. | ON-24 **pass**. ON-17 **pass** |
| 1c | `npm run shot -- / --port 4444 --widths 1280` (from the repo) | `[shot] no user in this database yet: pages show Getting started (/onboarding)`. It writes the PNG: **Set up · Step 1 of 6, "Your role"** (Solutions Engineer / Specialist AE). The page also shows a sticky toast: **"Command Center was updated. Version 2.0.0 is ready. Reload to use it"**. | Step 1 **pass**. The toast is **finding ON-28** |
| 2 | `npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor`, pasted literally, at about 80 s and again at about 90 s after the worker started | `✓ Port 4444: the web agent (pid …) on 127.0.0.1:4444` · `✓ LaunchAgents: installed and loaded; web :4444 up` · `✓ Worker heartbeat: starting, beat 6 s ago`, then `beat 1 s ago`. Every `fix:` line that names a command uses the pasteable `npm --prefix "$HOME/…"` form. No ✓ line says something is down. Exit 1, only because of claude and devbar. | ON-18 **pass**. A later run failed (see 5x and ON-30) |
| 3a | The install's own poll (`release-wiring.mjs` `waitForVersion` with `instanceId(current)`, as `wiring.health` calls it, in a 10-line `poll.mjs`), against the real web on 4444, then a fake server of mine on 127.0.0.1:4445 | 4444: `true`. Fake answering `{"version":"2.0.0"}` with no `instance`: **`true` (accepted)**. Fake answering `instance: "deadbeefdeadbeef"`: `another app answers on port 4445, not this install's web: see what holds it with lsof -i :4445, quit it (or set another PORT in the env file), then run this again`, then `false` at once. | **pass**. A reply with no `instance` is accepted by design (`release-wiring.mjs:87`, which treats it as a pre-ON-23 rollback target) |
| 3b | The real path: env file set to `PORT=4445` with the wrong-instance fake on 4445, then `npm --prefix "$HOME/…/releases/current" run ops:install` | `starting v2.0.0; waiting for it to answer…` · `another app answers on port 4445 … lsof -i :4445 …` · `Command Center did not answer on http://localhost:4445 after starting.` · doctor and log lines. Exit 1, within 1 s. web.log shows `EADDRINUSE 127.0.0.1:4445`. | **pass** |
| 3c | The same command with the fake answering no `instance` | `LaunchAgents written for releases/current (v2.0.0), started and answering on http://localhost:4445.` Exit 0. **The web had already exited** with `EADDRINUSE` (`[run-service:web] exited code=1`). Only my fake was on 4445. | **fail as a user result**: a false "answering", **ON-29** |
| 3d | Env file set back to `PORT=4444`, then `ops:install` | `started and answering on http://localhost:4444`. Exit 0. Doctor shows the web on 4444. | **pass** |
| 4a | `bash ~/Downloads/command-center/install.sh <same tgz> --reinstall` | `current release: 2.0.0` · `verified 13619 files` · `stopped web, worker` · `backed up the database` · `v2.0.0 is running` · **`installed v2.0.0 (was v2.0.0; npm --prefix "$HOME/…" run ops:rollback goes back)`** · doctor · `Open http://localhost:4444`. Exit 0. `ops:rollback -- --dry` then says `no earlier release to go back to (installed: 2.0.0)`, exit 1. | ON-25 **pass**. The rollback hint is **finding ON-31** |
| 4b | An unpacked copy with only `manifest.json` set to `"version": "1.9.0"`: `bash ~/Downloads/old/command-center-2.0.0/install.sh` | `verified 13619 files of v1.9.0` · `this build is v1.9.0 and you run v2.0.0, which is newer` · `Checking the build's version did not work (step: downgrade). Nothing changed … run the same command with --allow-downgrade …` · `this older build anyway: the same command with --allow-downgrade`. Exit 1. **No `ops:rollback` line.** | SEC-12 **pass**. ON-26 **pass** |
| 5 | `install.sh` with a missing tarball; `install.mjs` with a missing positional tarball, `--from-dir <missing>`, a non-gzip `.tgz`, a directory passed as the tarball, `--keep abc`, `--keep` with no value, and `--definitely-not-a-flag` | Missing tarball: `there is no file …/nope-2.0.0-arm64.tgz. Download the build from the Drive folder (or check the name), then run this again. Nothing changed.` Exit 1. Non-gzip and directory: tar's own line, then `Unpacking the build did not work (step: extract). Nothing changed …`. Exit 1. `--from-dir <missing>`: `no readable manifest.json at …`, then **`the unpacked build does not match its own file list (a damaged or edited download)`**. Exit 1. **None printed a stack.** `--definitely-not-a-flag` and a bare `--keep` were **ignored**: each ran the agents-only path (`starting v2.0.0 … started and answering on http://localhost:4444`, exit 0), which restarted the live web and worker. | P34-4 **pass**. **ON-32** (unknown options restart the app; the wrong message for a missing folder) |
| 5x | The doctor at 17:01:56, after the restarts in 3b–5 | `✗ Worker heartbeat: waiting: the database schema differs from the worker's build (beat 15 s ago); no jobs run [DATA.SCHEMA_BEHIND]`, `fix: … run db:migrate, then … ops:install` · `✗ Worker's last error: The background worker keeps stopping (BUG.WORKER_CRASH_LOOP)`, `fix: Report this` · on the same run, `✓ Migrations: 36/36 applied`. worker.log: every restart was `SIGTERM received` → `exited code=0`, then `crash loop: waiting before starting work`, `starts: 7`. | **fail**, **ON-30** |
| 6 | `npm --prefix "$HOME/…" run ops:uninstall -- --yes`, then I stopped the fake and the watcher and ran `rm -rf` on the walk folder | `removed com.commandcenter.web / .worker / .db` · `Command Center is stopped and will not start at login …`. Exit 0. No walk processes remain, Postgres included. `lsof` on 4444, 4445 and 4327 shows nothing. The 4327 watcher log is empty. No `command-center-install.*` temp folders are left. | **pass** |

### Findings (continuing the ON- numbers)
- **ON-28 (medium) [fixed 4f7bdbd: `build.mjs` removes `.next` before `next build` and fails when no `.next/static/chunks` file carries the build sha; `clientShaMatches`, `tests/release/build-client-sha.test.ts`]: every fresh install opens with "Command Center was updated … Reload", and every in-app navigation becomes a full page load.**
  - *Cause:* the client bundle and the server disagree about the build's sha.
    - The client chunk (`.next/static/chunks/7401-*.js`, `BuildWatch`) has `NEXT_PUBLIC_CC_GIT_SHA` = `"c1b99e8"`.
    - The server (`server.js` `nextConfig.env`, `required-server-files.json`) and `/version` say `a4ed1e2`.
    - So `isNewerBuild` (`src/components/shell/BuildWatch.tsx:23`) is true on the first check. It calls `markStaleBuild()` and shows the sticky toast.
  - *Likely root:* the release build's `next build` reused a client module from an earlier build in Next's persistent cache (`.next/cache`) instead of re-inlining the new `NEXT_PUBLIC_` value. That earlier build was made at `c1b99e8`. Alternatively, `.next/static` held stale chunks: `scripts/release/build.mjs:220` copies `.next/static` as it is.
  - *Who it hurts:* every teammate, on their very first page, and for as long as that build runs.
  - *Smallest fix:* in `scripts/release/build.mjs`, before `next build` (line 207), `rmSync(join(ROOT, '.next'), { recursive: true, force: true })` when `next` is set. After it, grep `.next/static/chunks` for the build's sha and `fail()` when it is missing. That check also catches `--no-next` reusing an old tree.
  - *Test:* a unit test on a helper `clientShaMatches(staticDir, sha)`, and the release smoke asserting `/version.sha` appears in the served chunk.
- **ON-29 (low): a foreign app that answers `/version` with the right version and no `instance` passes the health poll, and the install says "started and answering" while its web has died with `EADDRINUSE`.**
  - *Where:* `scripts/ops/lib/release-wiring.mjs:95`. The poll checks `instance` only when the reply has one, by design (`:87`, so that a pre-ON-23 rollback target is accepted).
  - *Seen in 3c:* exit 0 and a false success line. This is walk 2's "worse case", narrowed: any 2.0.0 web now sends `instance`, so the false pass needs either a pre-`2766f58` 2.0.0 build or a non-Command-Center app on the port.
  - *Smallest fix:* accept a reply with no `instance` only on the rollback path. Pass `instance` from `wiring.health` as before, and pass `allowNoInstance: true` only from the rollback's `deps.health(previous)`. Otherwise, before saying "answering", also check that the web agent's pid (`launchctl print`) is alive and holds the port, which the doctor's Port line already does.
- **ON-30 (medium) [fixed d60565e: a SIGTERM/SIGINT shutdown takes its own start back out (`forgetWorkerStart`); the doctor reads `last_error_code`: `crash_loop` says "the worker restarted N times in 10 minutes and is waiting" with `BUG.WORKER_CRASH_LOOP`, `schema_mismatch` (or none) keeps the schema text, anything else its own line; `tests/ops/crash-loop-clean-stops.test.ts`]: clean, requested restarts count as crashes. After about 6 installs, reinstalls or `ops:install` runs in 10 minutes, the worker sits in a 5-minute crash-loop wait. The doctor then calls this a schema mismatch and says "Report this".**
  - *Where (counting):* `src/worker/index.ts:115` counts every supervised start (`countWorkerStart`, `src/ops/crash.ts:28`). The counter ignores whether the previous run ended with `SIGTERM` → `exit 0`, which is our own `bootout` or `kickstart`.
  - *Where (wording):* `src/ops/checks/heartbeat.ts:21` maps every `hb.state === 'blocked'` to "the database schema differs … [DATA.SCHEMA_BEHIND]" with a `db:migrate` fix. The worker sets `blocked` for both `lastErrorCode: 'crash_loop'` (`index.ts:187-188`) and `'schema_mismatch'` (`:207-208`). The same doctor run says `✓ Migrations: 36/36 applied`.
  - *Who it hurts:* a teammate who retries the install a few times (or an update with a retry) gets no jobs for 5 minutes, a red doctor, the wrong fix, and a bug event in Health.
  - *Smallest fixes:*
    1. On a graceful shutdown (the SIGTERM path), drop this run's own start from `worker-starts.json`, through a new `forgetWorkerStart(now)` in `crash.ts`, so that only unclean exits count.
    2. In `heartbeat.ts:21`, branch on `hb.lastErrorCode`. For `crash_loop`, use "waiting 5 minutes after N starts in 10 minutes; `ops:install` after that, or report it if it keeps happening" and `BUG.WORKER_CRASH_LOOP`. Keep the schema text for `schema_mismatch` only.
  - *Tests:* `crashLoopState` after 7 graceful exits → no loop. The heartbeat check with `{state:'blocked', lastErrorCode:'crash_loop'}` → not `DATA.SCHEMA_BEHIND`.
- **ON-31 (low) [fixed 781bf51: the hint only when `r.previous !== r.version` and `rollbackTarget` finds a release]: the `--reinstall` success line offers `ops:rollback` when the "previous" release is the same version.**
  - *Where:* `scripts/ops/install.mjs:186` prints `(was v2.0.0; … ops:rollback goes back)` whenever `r.previous` is set. `ops:rollback` then answers `no earlier release to go back to`. ON-26 fixed the refusal path, but not this success line.
  - *Smallest fix:* print the hint only when `r.previous !== r.version` and `rollbackTarget(releasesDir)` is not null (the check `ops:rollback` makes).
- **ON-32 (low) [fixed 781bf51: unknown options and valued options with no value are refused with one line, exit 1, before anything runs; a missing `--from-dir` says "there is no folder <dir>"; `tests/ops/install-walk3-fixes.test.ts`]: `install.mjs` ignores options it does not know, and a missing `--from-dir` is reported as a damaged download.**
  - *Unknown options:* `scripts/ops/install.mjs:43-47,64`. A typo such as `--reinstal`, or `--keep` with no value, falls through to the agents-only path. That path stops and restarts the live web and worker, exits 0, and adds to ON-30's count.
  - *Missing folder:* `--from-dir <missing>` hits `release-manifest.mjs:77` (`no readable manifest.json`). `install-release.mjs:276` (`fail('verify')`) then words it as "does not match its own file list (a damaged or edited download)".
  - *Smallest fix:* refuse any `--x` that is not in the known option list (the header lines 15-26 plus `--help`), and any valued option with no value. Use one line, for example `unknown option --x (the options are …)`, and exit 1, as `install.sh:37` already does. For the folder, check `existsSync(fromDir)` first and say `there is no folder <dir>`.

### Fixed findings re-checked
- **Pass:** ON-22, ON-23 (both halves; see ON-29 for the no-`instance` edge), ON-24, ON-25, ON-26 (the refusal path), P34-4, SEC-12, ON-16, ON-17, ON-18, ON-14.
- **Not re-checked:** ON-27 (it needs a real failed health check after a switch), P34-1, ON-13 and ON-21 (build-side). This tarball installs and runs on its bundled engine (`17.12.0-beta.19`).

### Not covered
- A browser session past step 1 of onboarding (the screenshot shows step 1 only).
- A real 90-second doctor run with no restarts in between: the 80 s and 90 s runs passed, and the later runs were affected by ON-30.
- A downgrade to a build that was compiled as an older version.
