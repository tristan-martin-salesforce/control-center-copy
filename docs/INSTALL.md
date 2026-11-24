# Installing Command Center (for teammates)

Command Center runs on your own Mac as a web page only you can open, at <http://localhost:4327> ("localhost" means
"this Mac"). There is no app to drag into Applications (D-89), and nothing else to install first: it brings its own
database (D-98). You don't need to know Terminal: **Claude Code installs it for you** from the team's shared Google
Drive folder (D-90). It takes about ten minutes, most of it waiting.

The maintainer posts each release in the team's Command Center Slack channel, with the Drive folder's link and the
build's sha256 (a fingerprint: a long string of letters and numbers that only the real file produces). The folder
holds three files:

| File | What it is |
|---|---|
| `command-center-X.Y.Z-arm64.tgz` (or `-x64.tgz`) | the build: the whole app packed into one compressed file (about 137 MB; 441 MB once unpacked). `arm64` is for Apple silicon Macs (M1 and later), `x64` for Intel Macs |
| `manifest.json` | the release list: each build's file name and sha256, so the install can prove your copy is the published one |
| `install.sh` | the installer script (also inside the `.tgz`) |

## Before you start

You need **Claude Code** installed and signed in: Command Center reads Slack and Org62 through it. Terminal is the Mac
app where you type commands, and Claude Code runs inside it:

1. Press ⌘ Space, type `Terminal`, press Return. A window with a blinking cursor opens.
2. Type `claude` and press Return. If it says `command not found`, install Claude Code from
   <https://docs.claude.com/en/docs/claude-code/setup> first, then type `claude` again and sign in when it asks.

You also need **devbar** signed in for Gmail, Calendar and Drive; if it isn't, the install still finishes and
onboarding's Sources step shows the command to run. Command Center never asks for, reads or stores a password, token
or cookie.

## Install: paste this into Claude Code

In the Claude Code window, paste this, with `<Drive folder link>` replaced by the link from the Slack post, and press
Return:

```text
Install Command Center from <Drive folder link>.
1. With my Google Drive, download manifest.json, install.sh and the newest command-center-*.tgz for this Mac's chip
   (arm64 on Apple silicon, x64 on Intel) that manifest.json lists for the stable channel into
   ~/Downloads/command-center/ (create the folder).
2. Check the .tgz's sha256 (shasum -a 256) equals its row in manifest.json. If it doesn't, stop and tell me.
3. Run: bash ~/Downloads/command-center/install.sh
4. If the installer stops, read what it printed, tell me in plain words, and run the one command it names only
   after I say yes (for example brew install node@22).
5. When it finishes, open http://localhost:4327/onboarding.
Don't change anything else on my Mac.
```

Claude Code asks before it runs each command: read it, then say yes. You should see lines that start with
`[install]` scroll past. The last ones read `[install] Command Center is installed and running.` and
`[install] Open http://localhost:4327`, and your browser opens on **Getting started** (onboarding).

With no file named, `install.sh` uses the newest build for this Mac's chip in its own folder; `bash install.sh
<file.tgz>` names one.

### What Claude Code does, step by step

1. **Downloads the three files** with your own Drive access, in your own session. Command Center itself can only
   *read* Drive (its connector is read-only on purpose), so it can't download or install anything by itself.
2. **Checks the fingerprint.** The `.tgz` must have exactly the sha256 in `manifest.json`. A damaged or different
   file stops the install before anything in it runs.
3. **Runs `install.sh`**, which:
   1. finds Node.js 20-25 (the program Command Center runs on), or installs Node 22 with Homebrew
      (`brew install node@22`; Homebrew is the Mac's usual installer for such programs), or tells you the one command;
   2. checks that the `claude` program is there (it continues without it, and Health ▸ Setup shows it until it is);
   3. checks the build is for this Mac's chip, checks the sha256 again against every copy of `manifest.json` next to
      it (a browser names a second download `manifest (1).json`; one of them must list the build with that sha256),
      clears macOS's "downloaded from the internet" flag and unpacks the build into a temporary folder;
   4. runs the installer (`scripts/ops/install.mjs`):
      - checks **every file** against the build's own file list, that it is for this kind of Mac, and that its
        version is a plain version number (like 2.0.1) **not older than the one you run** (see below);
      - sets up **Command Center's own database** (Postgres 17, shipped inside the build) in
        `~/Library/Application Support/command-center/pg/` and starts it. It listens on a file in that folder only:
        no network port, nothing another computer can reach;
      - creates your settings folder `~/Library/Application Support/command-center/` and the settings file `env` in
        it (no passwords in it; it says where the database is and which port the page uses);
      - backs up the database, then updates it for the new build;
      - puts the build in `releases/<version>/` and points `releases/current` at it;
      - starts Command Center as **background services** (macOS calls them LaunchAgents: programs that start when
        you log in and keep running with no window): `com.commandcenter.web` (the page), `com.commandcenter.worker`
        (the scans) and `com.commandcenter.db` (the database). It waits until <http://localhost:4327> answers;
      - keeps the last three versions. **If anything fails, the previous version is put back and started again.**
   5. runs the **doctor**: a checklist of what's ready and what's left, each with its next step (see below).
4. **Opens onboarding** in your browser. Onboarding walks you through your role, your sources and the first scan.

Pasting the prompt again is safe. A version that finished installing counts as installed; if a background service is
stopped, the install starts it and waits for the page to answer.

### If the installer stops

Every stop says what happened, that nothing changed (or what did), and the one thing to do. Claude Code reads it to
you; this table has the same words, roughly in the order you could meet them (`…` stands for a file name or a
version):

| It says | What to do |
|---|---|
| `Command Center needs Node.js 22. Install Homebrew first (https://brew.sh), then run: brew install node@22 — and run this installer again.` | Ask Claude Code to install Homebrew from <https://brew.sh> (Terminal asks for your Mac password: that is macOS asking, not Command Center), then `brew install node@22`, then the install again. |
| `this Node.js is …` | Say yes to the command it names (`brew install node@22`), then the install again. |
| `Claude Code is not installed. …` | Not a stop: the install goes on. Install Claude Code afterwards (the line below it has the command); Health ▸ Setup shows it until then. |
| `… is the build for Apple silicon Macs, and this Mac has an Intel chip` (or the other way round), or `this build is for … Macs and this Mac has …` | Download the file ending in `-x64.tgz` (Intel) or `-arm64.tgz` (Apple silicon) from the same folder. |
| `… was unpacked by the browser (Safari does this)` (the file ends in `.tar`) | Download it again with Chrome, or turn off Safari ▸ Settings ▸ General ▸ "Open safe files after downloading". |
| `there is no file …` | The file name is wrong or the download is missing. Download the build again from the Drive folder. |
| `no Command Center build found next to this script.` | `install.sh` is alone in its folder. Download the `.tgz` and `manifest.json` into the same folder as `install.sh`. |
| `no manifest.json next to …` | Download `manifest.json` from the same Drive folder into the same folder as the build. |
| `the manifest.json next to … does not list it (an older manifest.json?)` | Download `manifest.json` again; an older copy from an earlier release does not list the new build. |
| `manifest.json (next to …) can't be used: …` | The file is not the release list (cut short, or another file with that name). Download `manifest.json` again from the same Drive folder. |
| `… is not the published build: its sha256 does not match` or `… could not be unpacked (an incomplete download?)` | Delete the `.tgz` and download it again (an incomplete or older download). |
| `the build does not carry a plain version number` | The file is not a Command Center build to install; tell whoever posted it. |
| `this build is v2.0.0 and you run v2.0.1, which is newer` | You downloaded an older build: download the newest one. To go back a version on purpose, see "Going back" below. To install that older build anyway: `bash install.sh <file.tgz> --allow-downgrade`; the database keeps the newer version's changes. |
| `v2.0.0 is already the current release (run the same command with --reinstall to install it again)` | Nothing to do: it is installed. To install the same version again anyway: `bash install.sh <file.tgz> --reinstall`. |
| `another app answers on port 4327, not this install's web: …` | Another program (or another Command Center install) uses the page's address. Ask Claude Code: "Show me what holds port 4327 (`lsof -i :4327`) and ask me before quitting it." Or change the line `PORT=4327` in the settings file `~/Library/Application Support/command-center/env` to another number, then run the install again. |
| `Run this in Terminal, then run the install again:` and a command | The database could not start; say yes to that command, then the install again. |
| `… did not work (step: …).` and a sentence | The sentence says what is true now (usually "Nothing changed" or "The previous release is back in place and running") and what to do. |
| `the install stopped on an unexpected error: …` | Run the doctor command at the end of that line (below). |
| `the install stopped (the lines above say why and what to run).` | Find the line just above it in this table. |

### Something went wrong: the doctor

The doctor checks everything (the database, the background services, your sign-ins, the port, disk) and says what to
fix. Ask Claude Code to run it, or paste it into Terminal yourself:

```bash
npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run doctor
```

(Paste it whole: the quotes matter, because the folder name has a space.) Each line starts with ✓ (fine) or a warning,
and a problem has a `fix:` line. A fix that is a command is written the same way, so you can paste it as it is, for
example `npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run ops:install` (starts the
background services again). When a fix doesn't help, or nothing makes sense, ask the team: click **Feedback** at the
top of any Command Center page (it adds the version and a diagnostics block with names and ids removed; you read and
edit it before it's posted), or, if the page won't open, post the doctor's output in the team's Command Center Slack
channel.

## Updating

When a new version is out, the Health page shows **Command Center X.Y.Z is available** (the app reads the Drive
folder's `manifest.json` once a day). Its **Ask Claude Code to update** button copies a prompt: paste it into Claude
Code. In an installed copy that prompt downloads the build from the Drive folder, checks its sha256 and runs
`update -- --from` that file (the line under the button says "Installed copy"); it looks like this, and you can paste
it yourself with the folder link and the version from the Slack post:

```text
Update Command Center to v2.1.0: from the Google Drive folder <Drive folder link> download manifest.json and the
command-center-2.1.0-*.tgz for this Mac's chip into ~/Downloads/command-center-update/, check the .tgz sha256
(shasum -a 256) equals its row in manifest.json, then run
npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run update -- --from ~/Downloads/command-center-update/<that .tgz>
and show me its output. Do not change anything else.
```

The update runs the same installer as above: fingerprint, every file, backup, database update, switch, restart, and
the previous version back if anything fails. It ends with `v2.0.0 → v2.1.0. Open http://localhost:4327`. A **major**
version (3.0.0) says in the announcement what you need to do first.

Why "ask Claude Code" and not a button that does it all: the app reads Drive through devbar's read-only Google
connector, which returns a file's **text**; a 137 MB build isn't text, so it can't come through that path. Claude Code
has your Drive in your own session and can download it.

### If you had 1.x: your data moves into Command Center's own database

1.x kept its data in a database Homebrew installed ("Homebrew Postgres"). The first 2.0 install (or, in a source
checkout, the second `npm run update`: [UPGRADING.md](UPGRADING.md)) moves it into
Command Center's own database by itself, right after the backup. You don't do anything; you see a few `[install]`
lines about the move. It checks the old data, copies it, compares every table row by row, and only then switches. If
anything doesn't match, nothing switches, your data stays where it was, and the next update tries again. The Homebrew
copy is left untouched for 14 days; after that the doctor prints the two commands that remove it (run them only if you
want the disk space back). If you set `DATABASE_URL` in the settings file yourself, it is left alone.

### If you had Control Center 1.x: the rename

The whole upgrade, with the agent's runbook and what is not automatic: [UPGRADING.md](UPGRADING.md).

Before the rename in 2.0 the product was called Control Center. The first start of 2.0 (the install, an update, or the doctor) moves
everything the old name owned, once, and prints one plain line per step (D-101):

1. the 1.x background services (`com.controlcenter.web` and `.worker`; 1.x had no database service) are stopped;
2. the 1.x folder `~/Library/Application Support/control-center/` becomes `…/command-center/` (instant: your settings,
   backups and database come along), and the 1.x logs `~/Library/Logs/control-center/` become `…/command-center/`;
3. the settings file's database address follows the move, and the database `control_center` is renamed
   `command_center` (if it can't be right now, the old name stays, the app works with it, one line says so, and the
   next update tries again);
4. the new services `com.commandcenter.*` are written from 2.0's template (the web listens on this Mac only,
   `127.0.0.1`), they start, and the old ones are removed; the newest 1.x backup is kept in `backups/pre-2.0/`, which
   the nightly clean-up never touches (`npm run restore -- --list`).

It is safe to run again: a move that stopped half-way (a closed laptop) is finished by the next start. If both folders
exist (you ran 2.0 before it could move the old one), Command Center uses `command-center`, says so, and leaves
`control-center` exactly as it is: nothing is merged or deleted; delete the old folder yourself once you know you don't
need it. Backups made under the old name (`control_center-<date>.dump`) stay in `backups/`, and restore and rollback
find them. (Developers: `node scripts/ops/migrate-state.mjs --check` says what it would do with the folder and the database.)

## Going back to the previous version

Ask Claude Code: "Roll Command Center back to the previous version: run
`npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run ops:rollback`".
It points `releases/current` at the previous version and restarts. The database keeps the newer changes (they only
add within a major version); the backup taken before them is named, if you ever need the data as it was.

The installer itself never goes back a version by surprise: a build older than the one you run is refused unless you
add `--allow-downgrade` (an old download left in `~/Downloads` would otherwise quietly replace the newer version).

## Where things are

`~/Library` is a folder Finder hides; to open one of these, press ⇧⌘G in Finder and paste the path.

| | |
|---|---|
| The app's builds | `~/Library/Application Support/command-center/releases/<version>/`, `current` → the running one |
| Your data | Command Center's own Postgres 17 in `…/command-center/pg/` (database `command_center`, reached through `pg/run/` only); nightly backups in `…/command-center/backups/` (7 daily + 4 weekly) |
| Settings file | `…/command-center/env` (only you can read it; no passwords) |
| Logs | `~/Library/Logs/command-center/` (`web.log` is the page's, `db.log` the database's) |
| Background services | `~/Library/LaunchAgents/com.commandcenter.web.plist`, `com.commandcenter.worker.plist`, `com.commandcenter.db.plist` |

To get data back: `npm run restore` (in the current release) unpacks the newest backup next to the live database and
starts it on its own, to look at; `npm run restore -- --replace --yes`, with Command Center stopped
(`npm run ops:uninstall`), puts it in place of the live one (which is kept beside it); then `npm run ops:install`.
[`RELEASING.md`](RELEASING.md) "The database" has the details. Ask the team before you replace anything.

## From a source checkout (developers)

Developers clone the repository and use `npm ci`, `npm run setup` and `npm run update` as in the [README](../README.md).
`npm run build:release` builds the same `.tgz` a teammate installs; `node scripts/ops/install.mjs <file.tgz> --unverified` installs it
(a build no release list names is refused without `--unverified`, and `install.sh` refuses one without the folder's
`manifest.json` next to it unless `CC_INSTALL_UNVERIFIED=1`).

## Uninstalling

```bash
npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run ops:uninstall
```

stops and removes the three background services (page, worker, database) and leaves your data, backups and logs where
they are; it prints the command that starts it again. To remove Command Center completely, delete
`~/Library/Application Support/command-center/` (this **deletes your data and backups**; copy `backups/` first if you
want them) and `~/Library/Logs/command-center/`. A leftover `~/Library/Application Support/control-center/` is the 1.x
folder from before the rename: it exists only when both folders were present (see above) and is yours to delete.
