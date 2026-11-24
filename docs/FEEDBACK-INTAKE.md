# Feedback intake

How a bug or idea from a teammate becomes a fix in a release. From [lane 11 R11](reviews/2026-11-20-holistic/11-packaging.md),
adapted to [D-90](decisions/0090-drive-distribution.md): builds ship through a shared Google Drive folder with a
Slack announcement, so there are no GitHub Releases. The maintainer (Tristan) runs this; agents never post or reply.

## Where feedback comes from
- **Report a bug / idea** in the app posts to the team feedback channel after the user reads and edits it and presses
  Send (D-56, an Outbox action behind dry run). Client and personal names are replaced by placeholders.
- Each post carries a scrubbed **Diagnostics** block: version · sha · modified · channel, and on a compiled install
  the **release line** (`release X.Y.Z · channel stable|beta · arch arm64|x64`, from the build's manifest), OS, Node,
  Claude CLI version, worker and migration state, connector states with their error codes, the last open app-event
  codes, the doctor summary and the last 50 redacted log lines. Its `top code:` is the grouping key.
- Nothing is sent automatically. There is no telemetry.

## Weekly, about 30 minutes
1. Read the feedback channel since last week's intake (and any thread replies).
2. File each post as one issue in the private repo's tracker (by hand, or with a Claude session you run that drafts
   them for you to file). Paste the post as written; never add customer names back.
3. Label it:

| Label | Values |
|---|---|
| `kind:` | `bug`, `idea` |
| `class:` | the error catalog's class of the top code (`src/errors/catalog.ts`): `dependency` (`DEP.*`, `MCP.*`), `auth` (`AUTH.*`), `network` (`NET.*`), `rate` (`RATE.*`), `data` (`DATA.*`), `bug` (`BUG.*`), or `none` |
| `code:` | the catalog code from the Diagnostics block's `top code:` line, exactly (e.g. `AUTH.LLM.GATEWAY_KEY`, `DATA.RELEASE.CORRUPT`), or `none` |
| `version:` | `x.y` from the post's version line |
| `release:` | `channel/arch` from the release line (`stable/arm64`), or `source` when the post has no release line (a source install) |
| `persona:` | `se`, `ae` |
| `sev:` | `blocker` (cannot use the app or a core flow), `major` (a flow is wrong), `minor`. A catalog `critical` code (`DEP.DB.DOWN`, `DEP.CLAUDE.MISSING`, ...) starts at `blocker` |
| `dup-of:` | the first issue with the same code and symptom |

The class follows from the code's prefix, so it needs no judgment: `class:dependency` and `class:auth` reports are
usually setup (answer with the catalog entry's next step); `class:bug` and `class:data` are ours to fix.

4. Triage with the rule below, then reply in each Slack thread.

## Triage rule
- A `code:` seen from **two or more users**, or **any blocker**, goes into the next **patch**.
- Other bugs go into the next minor, or the patch if the fix is small and safe.
- Ideas are rolled into the next **minor**, or become a [BACKLOG.md](BACKLOG.md) row when they need a design.
- A change that bends a tenet is not triaged into a release; it becomes a conversation with Tristan first.

## Shipping and replying
- Each release's [CHANGELOG](../CHANGELOG.md) lines cite the issues they close.
- `npm run release -- <level> --publish` (Tristan runs it) builds the compiled release and its feed `manifest.json`,
  and stages two items: the Drive upload (a handoff: drop the three files into the shared folder, or have Claude Code
  do it with your Drive) and the Slack announcement draft. Each install's daily update check then finds it through the
  devbar Drive read path ([RELEASING.md](RELEASING.md), "Publishing a compiled release").
- Reply in the original Slack thread:

```text
Fixed in vX.Y.Z (thanks!). Update from the banner in the app (Health > Setup gives you the Claude Code prompt).
What changed: <one line from the CHANGELOG>.
```

For an idea that is planned, not shipped:

```text
Thanks, this is planned for vX.Y (<one line>). I'll reply here when it ships.
```

For a duplicate: reply with the version that fixes it, or "tracking with <n> other reports, fix in the next patch".
