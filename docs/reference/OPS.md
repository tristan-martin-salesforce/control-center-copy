# Operations: keeping Command Center running

Owner: OPS lane (`ops/**`, `scripts/ops/**`, `src/ops/**`, `src/reauth/**`, `tests/ops/**`).
Requirements: R-UI-7 (runs in the background, resumes after downtime), R-UI-12 (health and re-auth), R-UI-16 (installable by teammates).
Decisions: D-7 (nightly backups, keep 7), D-14, D-22 (macOS notifications), D-39 (re-auth banner and button), D-42 (teammate prerequisites).

## What runs

| Piece | How | Where |
|---|---|---|
| Web (production `next start -p 4327`) | LaunchAgent `com.commandcenter.web` | http://localhost:4327 |
| Worker (`npm run worker:start`: scanner, job queue, engines; `npm run worker` is the dev variant with `tsx watch`) | LaunchAgent `com.commandcenter.worker` | no port |
| Postgres 17 | Homebrew service | :5432, database `command_center` |
| State (env, profile, heartbeat, backups, notification dedupe) | files, never in the repo | `~/Library/Application Support/command-center/` |
| Logs | rotated files | `~/Library/Logs/command-center/` |

Both agents have `RunAtLoad` and `KeepAlive`, so they start at login and restart after a crash. `ThrottleInterval` (10 s web, 15 s worker) stops a crash loop from spinning. After a weekend away the worker resumes from its cursors and job schedules (SCANNER §5, DATA-MODEL §1.5); nothing here needs to be done by hand.

Each agent runs `scripts/ops/run-service.mjs`, a small wrapper that:
1. loads the env file (values are never logged; secret-looking values are also scrubbed from the logs as a safety net);
2. waits for Postgres with `pg_isready` and exponential backoff (1 s up to 30 s, forever), so a login before Postgres is up does not crash-loop;
3. runs the real command with its output going to a size-rotated log;
4. forwards SIGTERM/SIGINT so the worker can drain (see "Worker contract");
5. exits with the child's exit code so launchd decides about restarts.

## Install

Installing writes persistent config into `~/Library/LaunchAgents`, so it is always an explicit step.

```bash
npm run setup            # once: state dirs, env template, DB, migrations, assets; then opens /onboarding
npm run build            # the web agent runs the production build
npm run ops:install      # asks for confirmation, then writes + loads both agents
npm run doctor           # everything green?
npm run update           # later: fetch, ask on a major, fast-forward, stop both agents, install, build, back up, migrate, start them (D-57, lane E)
```

`ops:install` resolves the repo path, the `node` and `npm` paths and `PATH` at install time and bakes them into the plists (`WorkingDirectory` is the repo). Re-run it after moving the repo or upgrading Node; it unloads and reloads the agents. Add `--yes` to skip the prompt, `--only web|worker` to install one, `--no-load` to write the plists without starting them.

To preview or lint without installing anything:

```bash
node scripts/ops/install-agents.mjs --out /tmp/cc-plists     # renders and runs plutil -lint, touches nothing else
```

Templates live in `ops/launchd/*.plist.tmpl` (placeholders `{{LABEL}}`, `{{REPO}}`, `{{PATH}}`, ...). The env file is passed as an argument, so no secret is ever written into a plist.

## The 1.x rename (D-101)

Control Center 1.x kept its state in `~/Library/Application Support/control-center/`, its agents were `com.controlcenter.*` and
its database `control_center`. `scripts/ops/migrate-state.mjs` (also run first by setup, install, update, pg-cluster,
ops:install/uninstall, backup, restore, rollback, doctor, `npm run dev`/`worker`, and the agents' `run-service.mjs`) moves all of
it once: stop the 1.x agents, rename the folder and the logs, rewrite the env file's socket path, rename the database, write
`com.commandcenter.*`, start what was running, delete the 1.x plists, record `migration.json`. Idempotent; both folders present
means the new one is used and the 1.x one is left alone. `node scripts/ops/migrate-state.mjs --check` says what it would do;
`docs/EDGE-CASES.md` "The folder migration" lists the cases; `docs/INSTALL.md` is the user's version.

## Uninstall

```bash
npm run ops:uninstall    # bootout + remove both plists. Logs, state and the database are kept.
```

Stop or restart one agent without uninstalling:

```bash
launchctl kickstart -k gui/$(id -u)/com.commandcenter.worker    # restart
launchctl bootout   gui/$(id -u)/com.commandcenter.worker       # stop (until next login or ops:install)
```

## Logs

`~/Library/Logs/command-center/`

| File | Content |
|---|---|
| `web.log`, `worker.log` | App output through the wrapper. Rotates at 10 MB, keeps `.1` to `.5` (`CC_LOG_MAX_BYTES`, `CC_LOG_KEEP` override). |
| `web.launchd.log`, `worker.launchd.log` | Only what launchd itself captures (wrapper crashes, bad paths). Normally empty. |

```bash
tail -f ~/Library/Logs/command-center/worker.log
```

Logs carry ids and codes only (tenet: privacy-safe logs). If you ever see a credential-like string, treat it as a bug and tell the owning lane.

## Doctor

```bash
npm run doctor                      # human output: ✓ ok, ! warning, ✗ failed, - skipped, with a fix hint
npm run doctor -- --json            # same data for the Health page
npm run doctor -- --skip mcp,budget # or --only heartbeat,devbar

Two rows added after 2.0 (read only, no launchctl, no file moves): `setup:state-folder` reads the migration marker (ok "command-center" or "command-center (moved from the 1.x folder on <date>)"; warn when the move is half done or the database rename was postponed, fix `node scripts/ops/migrate-state.mjs`). `data:read-scopes` counts page reads that fell back to the whole model (`BUG.READ_SCOPE_MISS`) since the web process started: the counter lives in the web process, so only `GET /doctor` and Health ▸ Setup (served by the web) show it, while the CLI and the worker report it as skipped; warn text "N reads fell back to the whole model since <start> (scopes: ...)", fix "report it; CC_READ_SCOPES=off if a page looks wrong".
```

Read-only. Exit code 1 when any check fails. Checks:

| id | What it checks |
|---|---|
| `node` | Node 20+ |
| `postgres`, `database`, `migrations` | PG17 accepting connections, `command_center` exists, drizzle migrations applied vs the journal |
| `assets` | Fonts and icons synced into `public/` |
| `claude` | `claude` CLI present and its version |
| `mcp` | `claude mcp list` shows `slack` and `Org62-Sobject-Read`, and whether each is connected or needs auth. Names and state only. `claude mcp list` health-checks but never starts a login. |
| `devbar` | devbar signed in, gateway listener up, `google_workspace_readonly` answering |
| `vdp` | PAT present (never printed) and the gateway cookie's age, decoded locally from its JWT `exp` |
| `ports` | talk-track :4320 and pulse-footprint :4318 (optional integrations, warning only) |
| `disk` | Free space: warn under 5 GB, fail under 2 GB |
| `state` | State dir exists and the env file is mode 600 |
| `agents` | LaunchAgents installed and loaded, web port answering |
| `heartbeat` | Worker heartbeat age (below) |
| `budget` | Today's LLM spend vs the total cap (`llm_budgets`, `llm_budget_days`) |

### Worker heartbeat format

`~/Library/Application Support/command-center/worker.heartbeat`, JSON, mode 600, replaced atomically every 15 s by `HeartbeatWriter` (`src/ops/heartbeat.ts`):

```json
{ "v": 1, "instance_id": "host:pid:uuid", "pid": 1234, "state": "idle",
  "started_at": "ISO", "beat_at": "ISO", "seq": 42, "active_jobs": 0,
  "app_version": "0.1.0", "last_error_code": null }
```

`state` is one of `starting | idle | running | catching_up | draining | stopping | stopped`. Fresh is up to 60 s old, stale up to 5 min (warning), dead beyond (failure). `stopped` means a clean shutdown. `instance_id` is the same id as `worker_instances.id`, so the worker can mirror each beat to `last_beat_at` through the `onBeat` hook. `last_error_code` is a code, never message text.

## Backups and restore

Nightly `pg_dump` (custom format) into `~/Library/Application Support/command-center/backups/`, newest 7 kept (D-7). Files are `command_center-YYYYMMDD-HHMMSS.dump`, mode 600. The PG17 binaries are used explicitly, because the `psql` on PATH may be v16.

```bash
npm run backup                         # now
npm run backup -- --if-due             # only if the newest backup is over 24 h old
npm run restore                        # newest backup into a NEW database, control_center_restore
npm run restore -- <file> --into my_check_db
```

BE-1's worker should schedule the nightly run (a `job_schedules` row with a catch-up policy) and call `backupDue()` / `runBackup()` from `scripts/ops/lib/backup.mjs`, so a laptop that slept through the night still gets one on wake. Until then, `npm run backup -- --if-due` can be run by hand. Restore never overwrites the live database by default. To replace it: stop the agents (`npm run ops:uninstall`), then `npm run restore -- --into command_center --replace` (you must type the database name), then reinstall the agents. Inspect the restored copy first with `psql -d control_center_restore`.

Test coverage: `tests/db/ops/backup.test.ts` does a real dump, prune, restore and compare on a scratch database `control_center_ops`, and drops it afterwards.

**Copy folder and freshness (lane E, E2).** `CC_BACKUP_COPY_DIR` (in the env file or the environment) gets a copy of every backup, newest 7 kept, written tmp + rename with mode 600. A failed copy (a disk not plugged in) never fails the backup. A cloud-synced folder (`~/Library/Mobile Documents`, `~/Library/CloudStorage/*`, `~/Dropbox`, `~/OneDrive*`, `~/Google Drive`) is refused (tenet: *Local data, privacy-safe logs*). `npm run doctor` (`backups`) warns when the newest backup, or the newest copy, is over 48 h old. It also warns when the copy folder is cloud-synced. The README says what a backup does and doesn't bring back.

## Re-auth (R-UI-12, D-39)

Handlers are in `src/reauth/`. Each has `status()` (read-only, never starts auth), `describe()` (the exact command) and `act({ confirm: true })`. Without `confirm: true` nothing happens. They return `{ kind, status, message, command? }`.

| Connector | Button | What happens |
|---|---|---|
| Slack | Re-auth Slack | Opens Terminal.app with `claude mcp login slack`. You finish the sign-in in the browser. |
| Org62 | Re-auth Org62 | Opens Terminal.app with `claude mcp login Org62-Sobject-Read`. |
| Google | Reconnect Google | Runs `devbar mcpgw connectors connect google-workspace-readonly` (opens a browser and polls). |
| devbar | Sign in to devbar / Restart devbar | `devbar auth login` / `devbar daemon start`. |
| VDP | Re-auth VDP | Runs `~/.claude/scripts/refresh_vdp_fir_cookie.py --no-window`. Silent when your Okta session is live. If it prints "needs MFA" (it still exits 0, so the handler parses the output and rechecks the cookie), the result is `needs_user`; the button then offers the window mode, which opens Terminal and runs the script without the flag so you can complete MFA. Off-network gives instructions only. |

None of these handle credentials. Fallback for Slack and Org62: in any Claude session run `/mcp`, pick the server, Authenticate.

## Notifications (D-22, UI-SPEC §9)

`src/ops/notify.ts`. Only four kinds ever become a macOS notification:

- `waiting_on_you` (only while the app is not focused);
- `failed_top3` (a run failed and its task is in the Top 3);
- `connector_broken` (data for today is affected);
- `brief_high` (only if the user opted in).

Everything else is inline, a rail lane or a badge. One notification per transition: the dedupe key is `kind:entityId:transition`, remembered in `notify-state.json` until the caller calls `resolve()` (the connector recovered, the item left that state). A global cap (6 per rolling hour by default) and quiet hours apply; a notification suppressed by quiet hours or the cap is not remembered, so a still-true condition can fire on the next sweep. Delivery uses `terminal-notifier` when installed (click opens `http://localhost:4327/...`), otherwise `osascript` (no click action). Text is passed as arguments, redacted and truncated.

## Worker contract (for BE-1)

```ts
import { HeartbeatWriter } from '@/ops/heartbeat';
import { Lifecycle, SingleInstanceLock, WakeDetector } from '@/ops/lifecycle';

const life = new Lifecycle(); life.installSignalHandlers();
const lock = new SingleInstanceLock({ client: dedicatedPgClient });   // pid file + advisory lock
if (!(await lock.acquire()).acquired) process.exit(0);
const hb = new HeartbeatWriter({ appVersion, onBeat: (b) => touchWorkerInstance(b) }); hb.start();
new WakeDetector(() => planResume()).start();                          // clock jump = the Mac slept

life.onShutdown('heartbeat', () => hb.setState('draining'));
life.onShutdown('abort runs + flush', () => drainJobs(life.signal));   // jobs get life.signal
life.onShutdown('release', async () => { hb.stop(); await lock.release(); await pool.end(); });
while (!life.stopping) { /* claim and run jobs */ }
```

launchd sends SIGKILL 20 s after SIGTERM (`ExitTimeOut`); `Lifecycle` gives up after 15 s.

## Teammate setup (D-42)

Prerequisites: Homebrew (Apple Silicon `/opt/homebrew` or Intel `/usr/local`: found with `brew --prefix`), Node 20+, Postgres 17 (`brew install postgresql@17 && brew services start postgresql@17`), the `claude` CLI, devbar, an admin-issued VDP PAT in your `vdp-app-fir` MCP entry, the cookie refresh script (`~/.claude/scripts/refresh_vdp_fir_cookie.py`, from the VDP app's repo, `docs/user-guide/skills/refresh-fir-mcp-cookie/`; README ▸ VDP sign-in; needs `python3 -m pip install --user playwright && python3 -m playwright install chromium`), Org62 authenticated in Claude Code, and Gemini notes enabled in Meet.

```bash
git clone <repo> && cd command-center && npm install
npm run setup          # infra, then the browser onboarding; --start also builds and installs the agents
npm run setup -- --headless   # scripted: prompts (or flags) for name, work email, persona, level, hours, time zone, Slack and Org62 ids
```

Setup is idempotent and does infra only: it checks prerequisites, creates `command_center` if missing (it prints the `createdb` command and asks first, or use `--yes`), runs migrations, syncs fonts and icons, and creates the state dirs (700) and an env template (600, with `CC_DATA=db`). Then it opens `/onboarding` in the browser; if the app isn't running it offers to build it and install the LaunchAgents first (`--start` says yes). `--headless` keeps the old terminal flow: it saves `profile.json` and bootstraps your user (`npm run db:bootstrap`, see "Going live"), so the browser onboarding never shows. It never handles OAuth: it prints the commands to run yourself.

**The browser onboarding (B-079, personas).** On a database with no user, every page sends you to `/onboarding`, six steps: role (persona and level: Solutions Engineer or Specialist AE), you (name, email, hours, time zone, Slack and Org62 ids), priorities (the level's starter weights and rules, editable), sources (your persona's sources plus the "Available" group, read-only sign-in status with the command for each), history (7, 14, 30 or 90 days with an estimated cost and a one-time backfill ceiling) and review. "Start first scan" bootstraps the user, saves the choices, starts the first scan (the worker applies the lookback and budget) and lands on Home, with the first-scan banner showing progress. A database bootstrapped by `npm run setup -- --headless` or `npm run db:bootstrap` never shows it. The unfinished draft waits in `<CC_STATE_DIR>/onboarding.json` (0600) and is deleted when you finish.

```bash
claude mcp login slack
claude mcp login Org62-Sobject-Read
devbar auth login && devbar mcpgw connectors connect google-workspace-readonly
python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py
```

Finish with `npm run doctor` (and, if setup didn't start it, `npm run build && npm run ops:install`). The sidebar footer then shows the version (`v1.0.0 · abc1234`); Settings ▸ About has the details. The Slack member ID is in Slack: your profile, the `...` menu, "Copy member ID".

## Going live (real data, empty database)

A real install starts from an empty `command_center` and never holds mock data: no seed, no fixtures, no fixture `scan.*` jobs (B-060). The web's db DataSource needs a user with `cc.meta`, every settings section and a current policy before it renders anything, so setup bootstraps them:

```bash
npm run db:bootstrap            # alone; npm run setup runs it after migrations and the profile
npm run db:bootstrap -- --email you@company.com --name "Ada Lovelace" --role se_ic --hours 07:30-17:30 --days 1-5 \
  --tz America/Denver --slack-id U0123ABCD --org62-id 005XXXXXXXXXXXXXXX     # flags override profile.json
```

Inputs, later wins: `profile.json` in the state folder (or `--profile <file>`), `CC_USER_EMAIL`, then the flags; with no email anywhere it falls back to `git config user.email`. It uses `DATABASE_URL` (default `command_center`) and prints the database name and what it wrote, never values. Idempotent: each step fills in only what is missing and never overwrites (a re-run prints `up_to_date`). It refuses a second, different user: the web serves the one active user of its database.

| What | Default |
|---|---|
| `users` + "me" (`people.is_me`) | email lower-cased (the key the worker's `CC_USER_EMAIL` resolves), name, time zone |
| `person_identities` | email, Slack member id, Org62 user id: the scanner's `me.slackId` (`scan-slack` from:/to: me) and `me.org62UserId` (`scan-org62` teams, events, DCs). Without them those scans find nothing of yours |
| Team pack `salesforce-se` | SE task types from `src/engines/activity/taxonomy.ts` (CR/CF flags, CF swaps, internal downgrades, meeting-type rule), Meeting_Type CF/CR |
| `settings.profile` | name, email, role, time zone, working hours (Mon to Fri unless `--days`) |
| `settings.sending` | dry-run **on**, default and per-channel mode `draft`, read-back on, 10 s undo |
| `settings.agentBehavior` | every autonomy level **L1** (a draft in the app; you send it), no voice samples, no watched sources |
| `settings.budgets` | $5 soft (alert at 80%), $15 hard, $2/day read-ins |
| `settings.display`, `settings.chat` | dark, comfortable, 16 px; chat on Sonnet |
| Policy v1 | the role pack's starter (SE IC or SE manager): the engine role template's weights through `policy-map.ts`, plus the template rules the contract can express |
| `cc.meta` | `label: live`, asOf / last active = now, the current Salesforce fiscal quarter (FY starts 1 Feb; due its last day at the end of your working day; 250 h target, `--quarter-target`), the work-order canvas |
| `llm_budgets` (total) | the soft budget, alert only: spend rolls up per day for the doctor's budget check |

Connectors are not bootstrapped: the scanner registers one row per connector on first use (`DbScannerStore.connectorId`), so there is never a second row per source. Health shows them with their label, a re-auth button per source, the real state and items today; before the first scan it is empty. Spend on Health is read from the LLM ledger (`llm_calls`) on a live database.

Rehearse on a scratch database (what WIRE ran; `CC_STATE_DIR` keeps the real state folder untouched):

```bash
export DATABASE_URL=postgresql://localhost:5432/control_center_wire CC_STATE_DIR=/tmp/cc-wire/state CC_LOG_DIR=/tmp/cc-wire/logs
node scripts/ops/setup.mjs --yes --non-interactive --name "Ada Lovelace" --email you@company.com --role se_ic \
  --hours 07:30-17:30 --tz America/Denver --slack-id U0123ABCD --org62-id 005XXXXXXXXXXXXXXX
CC_LIVE=1 CC_SCAN_LLM=1 CC_NOTIFY=0 CC_WORKER_RUN_FOR=1500 npx tsx src/worker/index.ts     # bounded live run, read tools only
# in a throwaway worktree with node_modules symlinked: npm run build, then
CC_DATA=db npx next start -p 4347
/opt/homebrew/opt/postgresql@17/bin/dropdb --force control_center_wire                     # it holds real data: drop it after
```

The switch itself (on `command_center`, in this order):

1. No worker or web may be running on `command_center` (`launchctl list | grep commandcenter` is empty; stop `npm run dev` on :4327, because the LaunchAgent web takes :4327 and `npm run build` rewrites `.next`).
2. `npm run setup -- --headless` (or with the flags above plus `--yes --non-interactive`). It writes the env file (`CC_DATA=db`) and `profile.json`, applies the pending migrations and bootstraps the user. Check: one row in `users`, 8 in `drizzle.__drizzle_migrations`, and `npm run db:bootstrap` prints `up_to_date`.
3. `npm run build`, then `npm run ops:install -- --yes` (the worker runs with `NODE_ENV=production`, so `CC_LIVE` and `CC_SCAN_LLM` are on).
4. `npm run doctor`, then open http://localhost:4327/health: every connector appears after its first scan.

Known gaps on live data (WIRE, 2026-11-06): the scanner writes source items, work items and evidence, but nothing materializes `calendar_events`, `claude_sessions`, `accounts` or `opportunities` from them yet, so Today shows no meetings (and its free-time estimate ignores them), Agents shows no Claude sessions and Deals is empty. The scanner reads its budgets and working hours from `user_settings` keys `budgets` / `profile`, while the app writes `settings.budgets` / `settings.profile`, so Settings edits do not reach it (its defaults equal the bootstrap's). The doctor's migrations check looks in `drizzle/` and its database checks use `command_center` whatever `DATABASE_URL` says.

## Troubleshooting

| Symptom | Check |
|---|---|
| localhost:4327 not loading | `npm run doctor`; `tail ~/Library/Logs/command-center/web.log`; was `npm run build` run? |
| Agents loop at login | The wrapper waits for Postgres. `brew services list`, then `worker.log`. |
| "Why wasn't this picked up?" / a run failed | `npm run scan:explain -- --url <permalink>`, `npm run scan:trace -- --last slack --failed`, `npm run scan:report -- --since 24h` (SCANNER §9). |
| Heartbeat stale after waking the Mac | Normal for a minute or two. The wake detector triggers catch-up; Health shows "catching up". |
| Worker will not start, "already running" | A live pid in `worker.pid`, or another process holds the advisory lock. `launchctl print gui/$(id -u)/com.commandcenter.worker`. |
| VDP banner keeps returning | Okta MFA lapses every 8 to 12 h; use the Re-auth VDP button, window mode. |
