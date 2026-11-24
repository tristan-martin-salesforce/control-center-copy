#!/bin/bash
# Command Center: the one-line install of a compiled build (D-89 localhost app, no desktop shell; D-90 Drive builds).
#
#   bash install.sh <path/to/command-center-X.Y.Z-ARCH.tgz>     the build you downloaded (manifest.json next to it)
#   bash install.sh                                            from inside an unpacked build (it sits at its root), or
#                                                              the newest build for this Mac next to the script
#   … --allow-downgrade                                        a build older than the one you run (refused otherwise)
#   … --reinstall                                              the version you already run, installed again (ON-25)
#
# What it does, in order (docs/INSTALL.md says the same in plain words):
#   1. Node.js 20-25: uses the one you have, or installs node@22 with Homebrew (or prints the one command)
#   2. Claude Code: checks the `claude` program is there (Command Center reads Slack and Org62 through it)
#   3. the build: checks its sha256 against the release feed (manifest.json from the same Drive folder), unpacks it
#   4. node scripts/ops/install.mjs: verifies every file, Command Center's own Postgres 17 (shipped in the build,
#      no Homebrew; a 1.x Homebrew database moves into it, verified), backup, migrate, switch,
#      LaunchAgents, and the new version answering; any failure puts the previous release back
#   5. npm run doctor: what is left to set up, each with its next step
# It never asks for, reads or stores a password, token or cookie. Sign-ins stay in Claude Code and devbar.
set -euo pipefail

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Command Center runs on macOS only."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
ARTIFACT=""
DOWNGRADE=""   # --allow-downgrade: install a build older than the one you run (refused without it, SEC-12)
REINSTALL=""   # --reinstall: install the current version again (ON-25: install.mjs's "already current" hint names it)
for a in "$@"; do
  case "$a" in
    --allow-downgrade) DOWNGRADE="--allow-downgrade" ;;
    --reinstall) REINSTALL="--reinstall" ;;
    -*) die "unknown option $a (the options are --allow-downgrade and --reinstall)" ;;
    *) [ -z "$ARTIFACT" ] && ARTIFACT="$a" ;;
  esac
done

# ---- 1. Node.js -------------------------------------------------------------------------------------------------
node_ok() { # $1 = a node binary; true when its major is 20..25
  local v
  v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ "$v" -ge 20 ] && [ "$v" -le 25 ]
}
NODE=""
for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ] && node_ok "$c"; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  BREW="$(command -v brew 2>/dev/null || true)"
  [ -z "$BREW" ] && [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew
  [ -z "$BREW" ] && [ -x /usr/local/bin/brew ] && BREW=/usr/local/bin/brew
  if [ -z "$BREW" ]; then
    die "Command Center needs Node.js 22. Install Homebrew first (https://brew.sh), then run: brew install node@22 — and run this installer again."
  fi
  say "installing Node.js 22 with Homebrew (brew install node@22)…"
  "$BREW" install node@22
  NODE="$("$BREW" --prefix node@22)/bin/node"
  node_ok "$NODE" || die "Node.js 22 did not install. Run: brew install node@22, then this installer again."
fi
export PATH="$(dirname "$NODE"):$PATH"
say "Node.js $("$NODE" --version) ($NODE)"

# ---- 2. Claude Code ---------------------------------------------------------------------------------------------
CLAUDE=""
for c in "${CC_CLAUDE_BIN:-}" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude "$(command -v claude 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE="$c"; break; fi
done
if [ -z "$CLAUDE" ]; then
  say "Claude Code is not installed. Command Center reads Slack and Org62, and writes its summaries, through it."
  say "  Install it:  curl -fsSL https://claude.ai/install.sh | bash   (then sign in: run claude once)"
  say "  The install goes on; Health ▸ Setup shows it until it is there."
else
  say "Claude Code $("$CLAUDE" --version 2>/dev/null | head -n1) ($CLAUDE)"
fi

# ---- 3. the build -----------------------------------------------------------------------------------------------
ROOT=""
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT
# No file given and not inside a build (bash ~/Downloads/install.sh): the newest build for this Mac next to the script.
# (A build has scripts/ops/install.mjs next to its manifest.json; the Drive folder's manifest.json is the release feed.)
is_build() { [ -f "$1/manifest.json" ] && [ -f "$1/scripts/ops/install.mjs" ]; }
if [ -z "$ARTIFACT" ] && ! is_build "$HERE" && ! is_build "$HERE/../.."; then
  ARTIFACT="$(ls -1 "$HERE"/command-center-*-"$ARCH".tgz 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$ARTIFACT" ]; then say "using $(basename "$ARTIFACT") (the newest build for this Mac in $HERE)"; fi
fi
if [ -n "$ARTIFACT" ]; then
  [ -f "$ARTIFACT" ] || die "there is no file $ARTIFACT. Download the build from the Drive folder (or check the name), then run this again. Nothing changed."
  ARTIFACT="$(cd "$(dirname "$ARTIFACT")" && pwd)/$(basename "$ARTIFACT")"
  NAME="$(basename "$ARTIFACT")"
  case "$NAME" in
    *-arm64.tgz) [ "$ARCH" = "arm64" ] || die "$NAME is the build for Apple silicon Macs, and this Mac has an Intel chip. Download the file ending in -x64.tgz from the same folder. Nothing changed." ;;
    *-x64.tgz) [ "$ARCH" = "x64" ] || die "$NAME is the build for Intel Macs, and this Mac has Apple silicon. Download the file ending in -arm64.tgz from the same folder. Nothing changed." ;;
    *.tar) die "$NAME was unpacked by the browser (Safari does this). Download it again with Chrome, or turn off Safari > Settings > General > 'Open safe files after downloading'. Nothing changed." ;;
  esac
  DIR="$(dirname "$ARTIFACT")"
  GOT="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
  # The release feed is manifest.json next to the build. A browser names a second download "manifest (1).json", so
  # every copy is read; the build passes when one of them lists it with this sha256 (SEC-3). A file is a feed by the
  # same rules as parseFeed (scripts/ops/lib/release-manifest.mjs; tests/release/install-sh-feed.test.ts keeps the two
  # in step): it can't be imported here, since nothing in the build runs before the feed matched.
  VERDICT="$("$NODE" -e '
    const fs = require("fs"), path = require("path");
    const [dir, name, got] = process.argv.slice(1);
    const files = fs.readdirSync(dir).filter((f) => /^(releases-)?manifest( \(\d+\))?\.json$/.test(f));
    const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;
    const feedOf = (s) => {
      const a = s.indexOf("{"), b = s.lastIndexOf("}");
      if (a < 0 || b < a) throw new Error("the release feed holds no JSON");
      let j;
      try { j = JSON.parse(s.slice(a, b + 1)); } catch { throw new Error("the release feed is not valid JSON"); }
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a Command Center release feed (not a JSON object)");
      const wrong = [
        j.schema !== 1 && `schema is ${JSON.stringify(j.schema) ?? "missing"}, not 1`,
        j.name !== "command-center" && `name is ${JSON.stringify(j.name) ?? "missing"}, not "command-center"`,
        !Array.isArray(j.releases) && "no releases list",
      ].filter(Boolean);
      if (wrong.length) throw new Error(`not a Command Center release feed (${wrong.join("; ")})`);
      return j.releases.filter((r) => r && SEMVER.test(String(r.version ?? "").trim()) && ["stable", "beta"].includes(r.channel) && /^[0-9a-f]{64}$/.test(String(r.sha256)) && typeof r.artifact === "string");
    };
    let listed = false;
    const invalid = [];
    for (const f of files) {
      let rows;
      try { rows = feedOf(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { invalid.push(f + "|" + e.message); continue; }
      const row = rows.find((r) => r.artifact === name);
      if (!row) continue;
      listed = true;
      if (String(row.sha256) === got) { process.stdout.write("ok " + f); process.exit(0); }
    }
    process.stdout.write(files.length === 0 ? "nofeed" : listed ? "mismatch" : invalid.length === files.length ? "invalid " + invalid[0] : "unlisted");
  ' "$DIR" "$NAME" "$GOT")"
  case "$VERDICT" in
    "ok "*) say "sha256 matches the release feed (${VERDICT#ok })" ;;
    "invalid "*)
      BAD="${VERDICT#invalid }"
      die "${BAD%%|*} (next to $NAME) can't be used: ${BAD#*|}. Download manifest.json again from the same Drive folder into $DIR, then run this again. Nothing changed." ;;
    mismatch) die "$NAME is not the published build: its sha256 does not match the release feed (a damaged or older download). Delete it, download it again from the Drive folder, then run this again. Nothing changed." ;;
    unlisted) die "the manifest.json next to $NAME does not list it (an older manifest.json?). Download manifest.json again from the same Drive folder into $DIR, then run this again. Nothing changed." ;;
    *)
      if [ "${CC_INSTALL_UNVERIFIED:-}" = "1" ]; then
        say "no manifest.json next to the build: installing it unverified (CC_INSTALL_UNVERIFIED=1, for a build you made yourself); its sha256 is $GOT"
      else
        # SEC-3: the manifest inside the build vouches only for itself, so nothing in it runs before the feed matched
        die "no manifest.json next to $NAME. Download manifest.json from the same Drive folder into $DIR (it proves the build is the published one), then run this again. Nothing changed."
      fi
      ;;
  esac
  # The build is the published one (or one you made). /usr/bin/tar copies macOS's "downloaded from the internet" flag
  # onto every unpacked file, the bundled database server among them, so it comes off the archive first.
  /usr/bin/xattr -d com.apple.quarantine "$ARTIFACT" 2>/dev/null || true
  TMP="$(mktemp -d -t command-center-install)"
  /usr/bin/tar -xzf "$ARTIFACT" -C "$TMP" 2>/dev/null || die "$NAME could not be unpacked (an incomplete download?). Download it again from the Drive folder, then run this again. Nothing changed."
  for d in "$TMP" "$TMP"/*; do
    if is_build "$d"; then ROOT="$d"; break; fi
  done
elif is_build "$HERE"; then
  ROOT="$HERE"
elif is_build "$HERE/../.."; then
  ROOT="$(cd "$HERE/../.." && pwd)"
fi
[ -n "$ROOT" ] || die "no Command Center build found next to this script. Download command-center-X.Y.Z-$ARCH.tgz and manifest.json from the Drive folder into $HERE, then run: bash $HERE/install.sh"

# ---- 4. install it (verify, database, backup, migrate, switch, agents, health; rollback on failure) -------------
"$NODE" "$ROOT/scripts/ops/install.mjs" --from-dir "$ROOT" --yes ${DOWNGRADE:+"$DOWNGRADE"} ${REINSTALL:+"$REINSTALL"} || die "the install stopped (the lines above say why and what to run)."

# SEC-14: the path goes in as an argument, never into the program text
CURRENT="$("$NODE" --input-type=module -e 'const { currentLink } = await import(new URL(`file://${process.argv[1]}`).href); process.stdout.write(currentLink())' "$ROOT/scripts/ops/lib/paths.mjs" 2>/dev/null || true)"
[ -n "$CURRENT" ] && [ -d "$CURRENT" ] || CURRENT="${CC_STATE_DIR:-$HOME/Library/Application Support/command-center}/releases/current"

# ---- 5. what is left to set up ----------------------------------------------------------------------------------
say "checking this Mac (npm run doctor)…"
(cd "$CURRENT" && "$NODE" dist/ops/doctor.mjs) || true

echo
say "Command Center is installed and running."
# the port the web runs with: the env file's PORT over the shell's, as at run time (ON-14, ON-16)
APP_PORT="$("$NODE" --input-type=module -e 'const [w] = process.argv.slice(1); const { servicePort } = await import(new URL(`file://${w}`).href); process.stdout.write(String(servicePort()))' "$CURRENT/scripts/ops/lib/release-wiring.mjs" 2>/dev/null || true)"
case "$APP_PORT" in ''|*[!0-9]*) APP_PORT=4327 ;; esac
say "Open http://localhost:$APP_PORT"
say "Getting started (first run): http://localhost:$APP_PORT/onboarding · the guide: $CURRENT/docs/INSTALL.md"
