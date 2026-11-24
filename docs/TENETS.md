# Command Center — Tenets

- **North stars** are ordered priorities. Use them to break ties; the higher one wins.
- **Design tenets** are invariants. Nobody, human or agent, violates one without an explicit conversation with Tristan.
- North stars pick the winner; design tenets veto options. Cite them by name, not number (e.g. *tenet: Nothing leaves without approval*).

## North stars (priority order)

1. **Trustworthy.** Nothing wrong or embarrassing leaves my machine. Every item traces back to its source, and the hours the app proposes are hours I really worked.
2. **Calm, not a firehose.** The app decides what matters *today*. On its first screen I see the next 3 things I should do, not 200 items. Everything else is one click deeper.
3. **Usable daily.** I open it every morning, and it saves me time from day one. Friction is a bug, and so is a dead end ("go do it somewhere else" without a link).
4. **Legible.** I can always see *why* an item is ranked where it is, what an agent did, and what it will do next.
5. **Fast to ship.** Thin vertical slices over completeness. A working connector beats a perfect schema.
6. **Low upkeep, team-portable.** Prefer battle-tested libraries and MCPs over bespoke code. Auth refreshes are scripted, not tribal knowledge. Nothing is hard-coded to Tristan that a teammate would need to change.

## Design tenets (invariants)

- **Nothing leaves without approval.** Every outbound action (Slack send, email send, VDP write, Org62 write, calendar change) goes through the single Outbox and its approval gate. No code path sends around it. Autonomy levels can only be raised per action type, by Tristan, in settings. The writes the user approved as product behavior (each only on their Apply or Send: the logging canvas D-47, VDP changes D-49, the feedback post D-56) go through the same gate.
- **Draft, don't send.** Agents produce drafts and dry-run payloads. A human click is the send. Build agents and validators *never* send, submit or write to real external systems.
- **Provenance on everything.** Every to-do, draft, time block and log entry links to the source item(s) behind it (deep link), and records why it was created or ranked.
- **Read-only ingest.** Connectors only read. Writes live in a separate outbound layer with its own adapters.
- **Connectors are adapters.** Each source implements one `Connector` interface and emits normalized `SourceItem`s. Core never imports a specific source.
- **Idempotent, re-runnable ingest.** Re-pulling a source never duplicates items, so cursors plus natural keys make any sync safe to repeat.
- **Hours are human hours.** Logged time reflects time Tristan actually spent. Claude's background or agent time is shown separately and never logged as his hours. Estimated signals (focused work, Slack, Claude hands-on) are never double-counted against real events; accepted meetings and a full onsite day all log, even where they overlap (D-18 amended 2026-11-11; Settings ▸ Time can count overlapping time once instead).
- **Suggest, then learn.** The app proposes mappings (meeting → opportunity). Finished work it may close for you (Tristan, 2026-11-09), but never silently: each close shows its reason, a link to the message that settled it, and Undo, in one Auto-closed list; what may close is set per reason in Settings. One-click corrections become rules, and it never overrides a correction: an item you reopened or kept is never closed again for you.
- **Local data, privacy-safe logs.** Data stays on this machine. App logs carry ids, statuses and timings, never message bodies or tokens. Credential-like strings found in sources are redacted at ingest.
- **Every handoff is one click away.** If something can't be done in-app (Org62 writes, travel booking, VDP asset links), the app prepares everything and gives a deep link plus copy-ready payload. It then verifies completion by reading the result back where it can.
- **Audit everything outbound.** Every approved, rejected or handed-off action is recorded: what, when, destination, and payload hash.
- **Config over code for people and teams.** Identity, team members, channels, deadlines, task-type lists and targets live in config or a "team pack", never in source.
