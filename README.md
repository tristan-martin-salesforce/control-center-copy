# Command Center

A personal-ops cockpit for Salesforce sellers that runs on your own Mac. It reads your Slack, Gmail, Calendar, Drive, Gemini meeting notes, Org62, VDP and Claude Code sessions. From them it builds one ranked to-do list, tracks where your time goes, and drafts your replies, Org62 activity logs, forecast notes and VDP updates.

**Nothing leaves without your approval.** The scanners only read. Every outbound message, canvas or record change waits in the Outbox, or on Activity, until you approve it. Dry run is on by default, so even an approved send only renders on your machine.

## Prerequisites

- **macOS** (Apple Silicon or Intel) with [Homebrew](https://brew.sh).
- **Node 22** (the version it's tested on, `.nvmrc`; 20+ runs, and `npm run doctor` warns on 25 or newer):
  ```bash
  brew install node@22
  ```
  `node@22` is keg-only: add it to your PATH as brew's note says (`/opt/homebrew/opt/node@22/bin` on Apple Silicon), open a new terminal, then check `node -v`.
- **Postgres 17** (only for a build from source; the compiled build brings its own, D-98):
  ```bash
  brew install postgresql@17
  ```
  ```bash
  brew services start postgresql@17
  ```
- **Claude Code**, signed in, with two MCP servers. The app reads Slack and Org62 through them:
  - `slack`: `claude mcp login slack`
  - `Org62-Sobject-Read`: `claude mcp login Org62-Sobject-Read`
- **devbar**, for Google (Gmail, Calendar, Drive, Gemini notes):
  ```bash
  devbar auth login
  ```
  ```bash
  devbar mcpgw connectors connect google-workspace-readonly
  ```
- Optional: **VDP** (`vdp-app-fir` MCP with an admin-issued PAT, plus the cookie refresh script), if your role fills in VDPs. See [VDP sign-in](#vdp-sign-in).
- Optional: the **Salesforce Sans** fonts from sfdc.co/fonts. Without them the app falls back to the system font.

The app never asks for or stores a password or token. Sign-ins stay with Claude Code and devbar.

## Install

**Teammates: you don't need anything in this section's code blocks.** Open Claude Code and paste the install prompt
from [docs/INSTALL.md](docs/INSTALL.md), with the Drive folder link from the team's Slack post. Claude Code downloads
the build, checks its fingerprint (sha256) and runs the installer, which sets up everything else (Node.js, Command
Center's own database, D-98, and the background services that keep it running), puts the previous version back if any
step fails, and opens onboarding. Updates come the same way: the Health page says **Command Center X.Y.Z is
available**, and INSTALL.md has the update prompt. If something goes wrong, INSTALL.md lists every message the
installer prints and what to do, and the doctor command to paste. Of the prerequisites above you need only Claude Code
and devbar signed in.

**From source** (developers, and the maintainer who builds the releases):

```bash
git clone <repo-url> command-center && cd command-center
```
```bash
npm ci
```
```bash
npm run setup
```

`npm ci` installs exactly what `package-lock.json` pins (and never rewrites it, so the next update's fast-forward applies).

`npm run setup` is safe to re-run, and does the infrastructure only:
- checks the prerequisites;
- creates your state folder, the env file and the database;
- applies the migrations and syncs fonts and icons;
- prints any sign-in commands you still need to run.

If the app isn't running yet, it offers to build it and install it as two LaunchAgents (web and worker), so it keeps running after you close the terminal. `--start` answers yes for you. Then it opens **onboarding** in the browser (<http://localhost:4327/onboarding>). Onboarding has six steps:

1. **Role**: your persona (Solutions Engineer or Specialist AE) and your level.
2. **You**: name, email, working hours, time zone, and your Slack and Org62 ids.
3. **Priorities**: your role's starter priority policy. You can edit it.
4. **Sources**: whether each of your role's sources is connected, with the exact re-auth command for any that aren't.
5. **History**: how far back the first scan reads, and its budget.
6. **Review**, then **Start first scan**.

The first scan runs in the background, and a banner on every page shows its progress. Home, Work and Deals fill in as it goes.

If you said no to the background install, run it later:

```bash
npm run build && npm run ops:install
```

For a scripted install with no browser, `npm run setup -- --headless` asks for your profile in the terminal, or takes it as flags.

`npm run doctor` checks everything (Postgres, migrations, sources, the Claude CLI the scanners run, who holds port 4327, the worker heartbeat, disk) and says what to fix. The maintainer-only checks (sibling apps, `~/Projects/PORTS.md`) run only with `CC_DEV_CHECKS=1`.

## VDP sign-in

VDP sits behind Okta, so it takes two credentials. Both live in your Claude config (`~/.claude.json`, the `vdp-app-fir` MCP entry), never in the app.

- **The PAT** (`Authorization: Bearer …`). An admin of the VDP app issues it to you, and it scopes VDP to the VDPs you're on. It's yours alone: keep it out of chats, tickets and files.
- **The Okta gateway cookie** (`Cookie: central_proxy_session=…`). It lives **one hour**. The refresh script gets a new one, and opens a browser window only when your Okta session itself has lapsed (about every 8 to 12 hours), so you can do MFA.

The refresh script ships with the VDP app's own repository (`vdp-app`, under `docs/user-guide/skills/refresh-fir-mcp-cookie/`). It isn't part of this repo. To set it up:

1. Save it as `~/.claude/scripts/refresh_vdp_fir_cookie.py`.
2. Give it Playwright:
   ```bash
   python3 -m pip install --user playwright
   ```
   ```bash
   python3 -m playwright install chromium
   ```
3. Run it once to check it works:
   ```bash
   python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py
   ```

If you keep the script somewhere else, or use another Python, set both in **Settings ▸ Sources**. `npm run doctor` says when the PAT, the cookie or the script is missing.

When the cookie lapses, Health shows **VDP needs re-auth**, and **Re-auth VDP** runs the script for you. Until then, VDP reads stay paused. The pause survives a restart, so a restarted worker doesn't keep trying a sign-in that already failed. If you ran the script yourself in Terminal, the next start sees the newer cookie and reads again.

## Personas

A persona **preconfigures** the app for your role. It never takes anything away (D-55).

- **Solutions Engineer**: replies and asks, meeting prep, Org62 activity logging against your quarterly hours target, deal contributions, missed opportunities, VDP coverage.
- **Specialist AE**: replies and asks, weekly Specialist Forecast notes by Monday, the Deal Role audit, missing forecast records, and hours logging.

Anything outside your preset still exists. It shows as "Available · not in your role's preconfiguration", and you can switch it on in **Settings ▸ Me ▸ Role & rules**. The same page holds your role's rules, which you can edit, your own rules, and thresholds such as "stale notes after N days on deals over $X".

## Finding your way

- **Getting started** (bottom of the sidebar): five outcomes to a working setup, counted on the card ("1 of 5"; an AE has four): connect your sources (and the first scan), pick your role, approve your first draft, log a week (one batch Applied; an AE's is the forecast notes), claim a deal contribution. Each one ticks itself from what you actually did; the page tours, the Assistant and feedback are optional steps under them.
- **?** next to each page title: what the page shows, where its data comes from, and its keys.
- **Tips** the first time you open a page. Bring them back in Settings ▸ Data ▸ About.
- **⌘K**: search, every command, and Help (keyboard shortcuts, this README, About). **?** opens the shortcut sheet.
- **⌘J**: the Assistant. Ask about a deal, a meeting or your week, or ask it to change something. It reads freely, and any change it proposes waits for you to apply. It keeps a preference only when you ask it to ("from now on …"); **Settings ▸ Budgets ▸ What the Assistant remembers** lists each one with the message it came from, and Forget. A Claude Code session it (or a page) prepares opens only after you read its prompt and click **Open in Claude**.

## Reporting a bug or an idea

Click **Feedback** in the top bar (or ⌘K ▸ Report a bug / idea).

1. The app diagnoses what it can: recent errors, the page you're on, a likely cause.
2. It replaces every customer, person, opportunity and id it knows with placeholders.
3. It shows you the final text to edit.
4. **Send** posts it to the team's feedback channel (D-56). That is the only place it posts, and only when you click. Dry run still applies.

The channel comes from `config/team.json`, or you can set it in **Settings ▸ Sending ▸ Feedback** (only you: the Assistant can't change it).

Every report carries your version, so the fix can say which version to update to. It also ends with a **Diagnostics** block: version and build, OS, Node and Claude Code versions, worker version, migration state, each source's state with its error code, the open error codes, the doctor summary and the last lines of the worker and web logs, with credentials, names and ids removed. You see and can edit all of it before Send.

## Troubleshooting

Every problem the app knows has an error code (`AUTH.SLACK.EXPIRED`, `DEP.DEVBAR.MISSING`, …), one next step and, where it can help, a button. You see them on Health, in `npm run doctor` (the code is in brackets after each problem) and in the Diagnostics block of a feedback report. The full list is `src/errors/catalog.ts`.

### Troubleshooting: Claude Code

Command Center reads Slack and Org62, and runs every model step, through Claude Code. `DEP.CLAUDE.MISSING`: install it (`curl -fsSL https://claude.ai/install.sh | bash`; it goes in `~/.local/bin`) or set `CC_CLAUDE_BIN`. `DEP.CLAUDE.TOO_OLD`: `claude update`. `AUTH.LLM.SIGNED_OUT`: run `claude` in Terminal and type `/login`. `AUTH.LLM.GATEWAY_KEY` (only with the company gateway): sign in to devbar. `RATE.LLM.USAGE_LIMIT` / `RATE.LLM.CREDIT`: your Claude plan's limit or credit. Health's **Check again** for Claude asks it for one word (about $0.001); it does not run without a configured gateway (`AUTH.LLM.NO_GATEWAY`).

### Troubleshooting: Slack and Org62

Both are MCP servers in Claude Code. `MCP.SERVER_NOT_DECLARED`: the server isn't added yet; add it with `claude mcp add --transport http <name> <url>` (the URL is in the team's setup notes), then sign in. `AUTH.SLACK.*` / `AUTH.ORG62.*`: click Re-auth on Health (a browser opens). `DEP.CLAUDE.SETTINGS_SOURCES`: sign-in started failing after the scanners stopped loading your Claude settings file; add `CC_SCANNER_SETTING_SOURCES=user` to the env file in the state folder, restart the worker and report it.

### Troubleshooting: Google (devbar)

Gmail, Calendar, Drive and meeting notes come in through devbar, the company developer toolbar. `DEP.DEVBAR.MISSING`: install devbar from the internal developer portal, then `devbar auth login`. `DEP.DEVBAR.DAEMON_DOWN`: Restart devbar on Health. `AUTH.GOOGLE.DEVBAR_SIGNED_OUT`: Sign in to devbar. `AUTH.GOOGLE.CONNECTOR_MISSING`: Reconnect Google. `NET.GATEWAY_DOWN`: devbar's gateway is down; nothing to do, the app retries.

### Troubleshooting: VDP

See [VDP sign-in](#vdp-sign-in). `AUTH.VDP.COOKIE_EXPIRED`: Re-auth VDP. `AUTH.VDP.MFA`: Re-auth VDP (window). `AUTH.VDP.NO_PAT` / `AUTH.VDP.PAT_REVOKED`: ask your VDP admin for a (new) PAT; re-auth can't fix it. `NET.VPN_REQUIRED`: turn on Zscaler. `DEP.PYTHON.NO_PLAYWRIGHT`: `python3 -m pip install --user playwright && python3 -m playwright install chromium`.

### Troubleshooting: network

`NET.OFFLINE`, `NET.TIMEOUT`, `NET.SERVICE_DOWN` and the `RATE.*` codes are retried with backoff; you don't need to do anything.

### Troubleshooting: database and worker

`DEP.DB.DOWN`: `launchctl kickstart -k gui/$UID/com.commandcenter.db` (a source checkout on Homebrew Postgres: `brew services start postgresql@17`); the error page says so when the database is the cause. `DATA.SCHEMA_BEHIND` / `DATA.SCHEMA_AHEAD`: `npm run update`. `DEP.WORKER.DOWN`: `launchctl kickstart -k gui/$UID/com.commandcenter.worker`. The worker runs the doctor's checks every 15 minutes and after it starts; Health ▸ Setup shows the result.

### Troubleshooting: sending

`SEND.*` codes are the Outbox's: nothing was sent unless the item says so; the next step is on the item.

### Troubleshooting: reporting a problem

`BUG.*` and `DATA.PARSE_DRIFT` (a source changed its format; that scope pauses instead of silently missing things) need a code fix: use **Report this**. The report carries the codes, so reports from several people can be grouped.

## Versions and updating

Versions follow semver (D-57, [docs/RELEASING.md](docs/RELEASING.md)):

| | Means | You |
|---|---|---|
| patch `1.0.1` | fixes | update any time |
| minor `1.1.0` | new features; migrations apply on their own | update any time |
| major `2.0.0` | something needs a step from you | read its [CHANGELOG](CHANGELOG.md) section first |

The sidebar footer shows your version (`v1.0.0 · abc1234`). When the build had local changes it adds `· modified` in amber, and a bug report says `modified (n files)` with the build's channel (`stable`, `beta`, or `dev` for a build from source). **Settings ▸ Data ▸ About** shows the build time, database migration, persona and worker version, and has a button that copies a one-line version report. If the footer turns amber, the web app and the worker run different versions, or a migration is pending.

To update:

```bash
npm run update
```

It runs these steps in order:

1. Fetches, and compares your running version with the new one. A **major** version prints its changelog section and asks before anything changes. Say no and nothing changes; `--yes` answers yes for you.
2. Looks at what was changed in this folder. A `package-lock.json` that npm rewrote is put back. Any other changed file, or a commit of your own, stops the update with the count and two options: save your changes to a branch `cc-local-<date-time>` and update (answer yes, or pass `--save-local`), or cancel, and nothing changes.
3. Fast-forwards, then stops both LaunchAgents (web and worker), so nothing runs on half-updated code.
4. Installs with `npm ci` (exactly the committed lockfile) and builds. The current build is kept aside until the new one succeeds.
5. Backs up the database, then migrates it (see [Backups](#backups)).
6. Starts both agents again and prints `old → new`, with the changelog in between.

If the install, build, backup or migration fails, it stops there. The database isn't migrated (a failed migration rolls back), the previous build goes back in place, and both agents start again. It then prints how to go back to the version you had.

Options: `--no-pull` (use the code already here), `--no-restart` (leave the agents alone), `--no-backup` (not advised), `--yes`, `--save-local`, `--dry` (print the steps, change nothing), `--from <build.tgz>` (install a compiled build instead of pulling; [docs/INSTALL.md](docs/INSTALL.md)), `--unverified` (with `--from`: a build you made yourself, which no release feed lists), `--help`.

A **compiled install** (from the Drive folder) has no git: `npm run update -- --from <command-center-X.Y.Z-ARCH.tgz>` checks the file's sha256 against the release feed (`manifest.json` from the same Drive folder, next to it) and refuses, changing nothing, when no feed lists the file (`--unverified` is only for a build you made yourself), verifies every file, backs up, migrates with the new build, switches `releases/current` and restarts; any failure puts the previous release back. `npm run ops:rollback` goes back to the previous one on purpose. The app checks the Drive folder for a newer version once a day (Health shows it); it reads the folder's `manifest.json` through devbar's read-only Drive path, so the download itself is done by your Claude Code ([docs/RELEASING.md](docs/RELEASING.md)).

The app answers only on this Mac: the web agent listens on `127.0.0.1`, and requests whose address isn't `localhost:4327` (or a change sent from another site) get a 403. A 1.x web agent installed before the loopback fix listens on every interface until you run `npm run ops:install` once; `npm run doctor` says so (`DEP.PORT.EXPOSED`).

Run it in the folder your LaunchAgents run. In another checkout of the repo (a second clone, a worktree), it refuses and changes nothing, because it would migrate the database the agents share and restart them on code it never built.

The worker only claims jobs when the database's migrations match the ones it was built with. If they don't (someone ran an older worker, or migrated by hand), it waits instead of exiting. Health shows "The background worker is waiting for the database" with the command to run, and `npm run doctor` says the same.

## Where your data lives

(Coming from Control Center 1.x: the first start of 2.0 moves the 1.x folder, background services and database to the new
names by itself, once: [docs/INSTALL.md](docs/INSTALL.md) "Coming from Control Center 1.x".)

Your data stays on this Mac, outside the repository:

| What | Where |
|---|---|
| Database | Postgres `command_center` (`DATABASE_URL` in the env file) |
| State, env file (`chmod 600`), profile, first-scan state, backups | `~/Library/Application Support/command-center/` |
| Logs (rotated, secrets scrubbed) | `~/Library/Logs/command-center/` |
| Private material moved out of the repo | `~/Library/Application Support/command-center/private/` |

Nothing about you is committed: `.gitignore` covers research notes, fixtures and private config.

### Backups

The worker backs up the database every night at 02:30, or on wake if the Mac slept through it. `npm run update` also backs up before it migrates. Backups go to `~/Library/Application Support/command-center/backups/`: the newest 7, plus the newest of each of the 4 weeks before them, are kept. Command Center's own database gets a base backup (`command_center-<date>.base.tgz`); Homebrew Postgres or a `DATABASE_URL` you set gets a `pg_dump` (`.dump`). `npm run doctor` warns when the newest one is over 48 hours old.

```bash
npm run backup
```
```bash
npm run restore
```

`npm run restore` puts the newest backup into a **copy** (a dump into a new database, `command_center_restore`; a base backup into a copy of the database folder), so you can look at it first. [docs/reference/OPS.md](docs/reference/OPS.md) ("Backups and restore") explains how to replace the live database with it.

A backup on the same disk doesn't help if the Mac is lost. To also write each backup somewhere else, add a copy folder to the env file (`~/Library/Application Support/command-center/env`), for example an external disk:

```bash
CC_BACKUP_COPY_DIR="/Volumes/Backup/command-center"
```

The newest 7 are kept there too. If the disk isn't plugged in, the backup still runs and the copy is skipped; doctor warns once the copy is over 48 hours old. A cloud-synced folder (iCloud Drive, OneDrive, Google Drive, Dropbox) is refused, because it would take customer data off your Mac.

**What a backup brings back:** everything in the database as of that night. That covers your to-dos, decisions, drafts, Outbox history, time and logging, deals and DC requests, the VDP mirror, settings and rules, the model-spend audit trail, and Undo history (detailed for 90 days).

**What it doesn't:**
- What you did in the app since that backup, up to a day of approvals, edits and dismissals. Messages and records from your sources come back with a rescan, which costs model spend.
- Anything outside the database: the env file, `profile.json`, the first-scan state, `private/`, and logs. Copy the state folder yourself if you want them.
- Your sign-ins: Claude Code's MCP logins, devbar, and the VDP PAT and cookie in `~/.claude.json`. Sign in again (see [Prerequisites](#prerequisites)).
- Anything older than the oldest backup kept (7 nights and 4 weekly), and message bodies over 90 days old, which the app removes on purpose.

What already left your Mac stays where it went: Org62 Events, VDP changes, Slack posts. The Org62 read-back brings your logged Events into Time again.

### What the app keeps, and for how long

| What | Kept |
|---|---|
| Message bodies from sources | 90 days, then removed (titles, links and hashes stay) |
| Scan trace (why an item was or wasn't picked up) | 30 days |
| Scan coverage ledger | compacted after 30 days: the same coverage in far fewer rows |
| Scan runs | 90 days, unless something still points at them |
| Background jobs | 30 days when finished, 90 when failed, 400 for Outbox deliveries and VDP pushes; the last of each kind always stays |
| Connector health checks | 30 days; the latest per source always stays |
| Model calls and decisions (the spend audit trail) | 400 days each, then rolled up into daily totals, which are kept |

The nightly cleanup (03:15) never deletes a row that something still points at: a draft keeps the model call that wrote it, and a source item keeps the scan run that first saw it.

## Sharing the repo

Before pushing to a new remote, run:

```bash
npm run scan:private
```

It reads your real account, person and opportunity names from your local database at run time, and writes them nowhere. It scans every tracked file and every commit for those names, for Org62 and Slack ids, and for salesforce.com emails. It prints **file paths and counts only**.

If it finds anything in tracked files, move those files to the private folder or replace the values with placeholders. If it finds anything in **history**, publish the `share` branch instead of this history. `share` holds one commit per release, made from the release tag's files only: no history, and nothing uncommitted. Test files build their invented tokens at run time, so GitHub push protection has nothing to block.

The first release you share:

```bash
git branch share $(git commit-tree "v1.1.0^{tree}" -m "Command Center v1.1.0")
```

Every later release goes on top of it, so `npm run update` (a fast-forward pull) keeps working for everyone:

```bash
git branch -f share $(git commit-tree "v1.2.0^{tree}" -p share -m "Command Center v1.2.0")
```

Then push only that branch, as the remote's `main`:

```bash
git push origin share:main
```

Never push `main` or your tags: they carry the full history. Keep that history local.

## Development

| Task | Command |
|---|---|
| Dev (web on :4327 + worker) | `npm run dev` |
| Web only, mock data | `PORT=4350 CC_SEED_PATH=src/mock/seed.example.json npm run dev:web` |
| Mock data at scale | `CC_SEED_SCALE=7 CC_DATA=mock PORT=4350 npm run dev:web` (the seed ×7: six weeks of activity, 120+ work items, 60+ VDP items; placeholders) · crawl it: `npm run smoke:crawl -- --mock --scale 7` |
| Typecheck, lint, unit and UI tests | `npm run check:fast` (`npm run check` adds the Postgres suites and the evals) |
| Screenshots | `npm run shot -- <route>` (needs a running server) |
| Release (maintainers) | `npm run release -- patch\|minor\|major` (see [docs/RELEASING.md](docs/RELEASING.md)) |

Read [CLAUDE.md](CLAUDE.md) and [docs/TENETS.md](docs/TENETS.md) before changing anything. The invariants there (read-only connectors, approval before anything leaves, no secrets in logs) are not negotiable.
