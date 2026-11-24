# D-90: Releases ship as a compiled build in a shared Drive folder

- **Status:** Accepted · built, 2.0 (chunks p4-compiled-build-distribution, p4-release-outbox-items)
- **Date:** 2026-11-20
- **Source:** H-12 (deviation: no GitHub Releases, no Heroku). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 11](../reviews/2026-11-20-holistic/11-packaging.md) D-C/D/E, R8, R10, R11

## Context
Teammates update through `git` today; a failed update rolled back only `.next`, and the worker runs TypeScript source. Feedback posts carry no machine diagnostics, so reports from several users cannot be grouped.

## Decision
- `npm run release -- --publish` (Tristan runs it) builds the compiled app, writes a manifest (version, sha256, changelog), puts it in a shared Google Drive folder and drafts a Slack announcement.
- The app checks for and fetches updates through the devbar Drive read path it already uses; install has full rollback. To verify early: devbar's Drive tool can download a 100-200 MB file.
- Feedback returns through the Slack post (D-56) with a scrubbed diagnostics block and the last 50 redacted log lines, editable before Send.
- A weekly intake turns posts into tracked work: [`docs/FEEDBACK-INTAKE.md`](../FEEDBACK-INTAKE.md).

## As built (W12-7, 2026-11-20)
The two release items are ordinary Outbox drafts: `npm run release -- --publish` creates them through the running app
(`POST /outbox/releases`, idempotent per version: a second publish updates the pending pair, never a second one), or,
when the app is not running, leaves `dist/releases/outbox-<v>.json` for `npm run release:outbox`. `release.drive_upload`
is a hand-off with no tool call in any mode: its row offers "Copy upload instructions" (the prompt for Claude Code)
and "Mark uploaded", which records the hand-off as a `record_landings` row of kind `release`. `release.announce` is
the D-56 `slack_send_message` payload to `distribution.announceChannel`, approved with the usual preview, confirm,
undo window and dry run, and posted live only by the worker's release relay to that one channel. The Outbox write
allowlist is unchanged (21 tools); the only write is the existing Slack send on Approve.

## Consequences
- Agents never publish or push; the release command refuses on any `scan:private` hit.
- No telemetry: the user-approved feedback post is the only signal back.

## Supersedes
D-29 (repo plus `npm run setup`). Amends D-56 (the post gains diagnostics) and D-6 (teammates get the build, not the repo).
