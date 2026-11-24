# 35 · Review of the final post-2.0 merges (`fb7c5b6..a94dffd`)

Reviewer: Claude Fable 5.1 (fork), 2026-11-21 evening, on a94dffd. Review only; nothing fixed here.
Scope: everything merged after review 34: `post-a11y-last`, `post-a11y-rescan`, `post-review34-fixes` (the per-run
advisory lock, the step-limit pin), `post-scan-placeholders`, `post-scan-fixtures`, `post-install-walk-2`,
`post-install-fixes-2` (ON-23..27, P34-1, P34-4, P34-6). 45 files, +910/−137.

## Summary

| Severity | Count | |
|---|---|---|
| Blocker | 0 | |
| High | 0 | |
| Medium | 1 | P35-1: a timed-out axe scan is dropped from the comparison and the run still exits 0 |
| Low | 2 | P35-2: a `/version` reply with no `instance` passes the health poll on its version alone; P35-3: the scan's placeholder shapes could hide a real Org62 id pasted in the wrong case (the DB-backed exact match still catches it) |
| Info | 2 | P35-4, P35-5 |

Nothing in the delta writes to Slack, Gmail, VDP, Org62, Calendar or Drive. The MCP allowlist is untouched. No tracked
`node_modules`, `.shots` or `dist/`. The walk-2 section quotes no credential-like text; the axe baseline holds two
rows of counts; the scan tests' ids are joined at run time from obviously synthetic parts.

## Findings

### P35-1 (Medium) A timed-out axe scan hides a regression and the run still passes (fixed 9d02b09)

`tests/a11y/axe-pages.ts:259-275` (`bounded`): a scan that runs over `SCAN_MS` becomes a `PageResult` with
`skipped: 'timed out: …'` and no violations. `axe-pages.ts:322`: `now` is built from results `if (!r.skipped)`, so a
timed-out page is simply absent from the comparison; `:339` returns `worse.length ? 1 : 0`, so a run whose every page
timed out prints `0 new` and exits 0. The lane's own first full run stalled on Home; with this scanner the same hang
would now read as a pass.

*Verify:* `npm run test:a11y -- --port <p> --scan-timeout 1` → every row `tout`, the summary says `122 scans, 0
violating nodes, 0 new`, exit 0.

*Smallest fix:* count `skipped` results as failures: after the loop, `const stalled = results.filter((r) => r.skipped)`,
print them under the summary, and `return worse.length || stalled.length ? 1 : 0`. If an `error:` skip must stay
tolerated for a page the mock cannot show, allow it only for an explicit list, never for `timed out`.

### P35-2 (Low) A reply without `instance` passes on its version alone (fixed 339206f)

`scripts/ops/lib/release-wiring.mjs:89-99` (`waitForVersion`): the foreign-port check fires only when the reply carries
an `instance` string that differs. A reply with the right `version` and no `instance` is accepted, by design, for a
rollback target built before 2766f58. But the install path has the same rule, so another app, or a 2.0.0 build from
this morning still running on the port, passes the health poll after a fresh install, which is the ON-23 case the
field exists for. Every build from a94dffd on carries `instance` (`src/server/version.ts:155`).

*Verify:* a stub server on the port answering `{ "version": "2.0.0" }` with no `instance`; `installRelease` reports
success.

*Smallest fix:* give `waitForVersion` a `requireInstance` flag: the install and update paths pass `true` (a reply
without `instance` is foreign, print `foreignPortMessage`), the rollback path passes `false`. One unit test each in
`tests/ops/install-walk2-fixes.test.ts`.

### P35-3 (Low) The placeholder shapes can hide a real Org62 id in the wrong case; the DB pass still catches it (fixed 621dda9; the RELEASING.md line is left to the docs lane)

`src/lib/private-scan.ts:96-118` (`placeholderShape`): `checksum` classes an 18-character id whose last three
characters are not the case checksum of the first fifteen as a placeholder. A real id copied through something that
changed its case (a lowercased URL slug, a spreadsheet with "upper-case all") fails the checksum and is counted as
placeholder-shaped, so the offline scan does not name the file. `PLACEHOLDER_WORD` is `/i`, so a real id spelling
`test` in mixed case is hidden too (about 2 in 10,000 real ids). The DB-backed `knownIds` matcher
(`private-scan.ts:250`) matches exact values whatever their shape, and `--show-placeholders` lists the files, so the
run before the push is still trustworthy; the offline run is the one that can miss.

*Verify:* lowercase a made-up id with a valid checksum; `placeholderShape(lower, 'org62')` → `'checksum'`.

*Smallest fix:* apply `checksum` only when the id's case pattern is plausible for a real id (at least one upper-case
and one lower-case letter in the first fifteen, as Salesforce writes them), and drop `/i` from `PLACEHOLDER_WORD` for
Org62 (keep it for Slack, whose ids are upper-case). Say in `docs/RELEASING.md` that the offline scan is a
pre-filter and the DB run is the gate (it nearly says so).

### P35-4 (Info) Port defaults outside the install path

`scripts/ops/start-web.mjs:16` (`process.env.PORT ||= '4327'`) is the web's own default when neither the env file
nor the shell set one; the LaunchAgents hand the service the env file through `run-service.mjs`, so the file wins
there as ON-14 says. `release-wiring.mjs:25` (`launchAgents`'s `port = Number(env.PORT) || 4327`) is a default
nobody uses: `realDeps` passes `() => servicePort(env, fileEnv())` (`:164`). No action; noted so nobody "fixes" the
default into a second rule.

### P35-5 (Info) The no-user health payload

`src/server/health-no-user.ts:16-25`: `dryRun: true`, empty connectors and spend, `worker.alive` from
`worker_instances.last_beat_at` within 120 s. Nothing in `src/ops/checks` or the client reads `reason: 'no_user'`
yet; the Health page needs a user anyway, and the installer and `npm run shot` only need the 200. Fine as is.

## Verified OK

- **Invariants.** No new sender; `git ls-files | grep -E "node_modules|^\.shots|^dist/"` empty; no credential-like
  text in `20-onboarding-dry-run.md` §Walk 2 or `tests/a11y/baseline.json`; the scan tests build ids at run time
  from `SMPL`/word parts. `CC_LAUNCHCTL` is read in `launchctl.mjs` only; the walk-2 test sets `HOME`,
  `CC_STATE_DIR`, `CC_LAUNCH_AGENTS_DIR` and `CC_LOG_DIR` to a `mkdtemp` folder (`install-walk2-fixes.test.ts:23-24`)
  and runs only `install.sh`'s option loop under `/bin/bash` with a stub `die` (`:52-61`), so nothing reaches the
  real state folder or the real agents.
- **`instance`** (`src/server/version.ts:155-170`, `release-wiring.mjs:70-78`): both sides hash `realpathSync` of the
  folder, the web's `process.cwd()` (Next standalone changes into the release root, which `current` links to) and the
  installer's `currentLink(env)`, read when `health` is called, after the switch or the rollback repointed `current`.
  Same path, same hash; a symlinked `current` resolves the same way on both sides. The dev server and `npm run start`
  from a checkout report a hash of the checkout path, which nothing compares. A path hash is not a raw path; the path
  itself is not exposed.
- **`/api/v1/health` before a user** (`domains/health.ts:79-87`, `ctx.ts:101-102`): only the "no user" error becomes
  the empty payload; "several users" and database errors still throw. The payload matches `HealthPayload` with the
  new optional `reason`. No other route gained a no-user branch.
- **Ports** (P34-1, ON-23): `servicePort` (env file over shell) in `update.mjs:161,172`, `setup.mjs:127`
  (`onboardingUrl`), `install.mjs:182`, `release-wiring.mjs:164,179`; a new env file starts from the shell's valid
  `PORT` (`setup.mjs:38-41`, used by `realDeps.ensureEnv` and `ensure-db.mjs:100`). `install.sh`'s option loop
  (`--allow-downgrade`, `--reinstall`, unknown option, artifact in any order) parses and runs under the Mac's bash 3.2
  (the unit test spawns `/bin/bash`). The uncaught handlers print one line and `exit 1` (`install.mjs:51-57`); the
  normal exit paths are untouched, and install.sh's own `die` line follows, which is the intended two lines.
  `rollbackTo` scans `state.json` history for an earlier release still on disk (`install-release.mjs:317`);
  `previousRunning` comes from a real `deps.health(previous)` after the rollback restart (`:410`).
- **Recovery lock** (`recovery.ts:182-186`): `recoverInterruptedWork` books runs one at a time (`:148-150`), so each
  recovery holds one transaction connection while the store writes on another (pool max 5, `db/client.ts:107`); the
  lock is released when the transaction returns, after `recordSpend` has committed on its own connection, so the
  second recovery reads the rows booked. `hashtext` is 32-bit: a collision only serializes two unrelated runs. No
  advisory lock is taken inside the store, so no lock-order cycle with `landings.ts`, `chat.ts` or projections. The
  concurrency test runs two `recoverInterruptedWork` on one pool of six (`crash-resume.test.ts:42,276-277`): two
  transactions, two connections. 12/12 on `review35`.
- **Axe baseline** (`tests/a11y/baseline.json`): two rows, `dark /history` and `light /history`, 3 each, which is
  exactly what `--update` writes from a run with those as the only violations (`axe-pages.ts:322-328` keeps only
  pages with a known violation, sorted).
- **Tests.** typecheck 0; lint 0 errors, 0 warnings; `tests/ops tests/server tests/handoff tests/release
  tests/hygiene`: 59 files, 578 passed (the ENG-5 bounds unchanged, no hygiene file in the delta); no new real timer.
- **Docs vs code.** ON-23..27 marked fixed with shas that exist (`2766f58`, `cc1c734`, `c08eafc`, `aa23472`);
  P34-1/4/6 rows fixed with `2766f58`, `b0134f1`; P34-3/5 with `f480868`, `e510ce1`. `docs/INSTALL.md`'s three new
  rows quote the real messages (`install-release.mjs:325`, `release-wiring.mjs:81`, `install.mjs:53`).
  `docs/RELEASING.md` has the placeholder paragraph and the main-checkout sentence. CHANGELOG's a11y line says six
  nodes, the baseline agrees.

## STATUS-2.0 §6 must also say

1. §6.5 with the final tree's numbers (the orchestrator's run).
2. §6.3: a check for the foreign-port message (another app on the port → the install fails with `lsof -i :<port>` in
   the line and rolls back), and, after P35-1, that `npm run test:a11y` fails on a timed-out page.
3. §6.4: the offline `scan:private` is a pre-filter (4 files left, Tristan's); the DB-backed run is the gate.

## Manual checks for the work machine

- Install from a tarball with `PORT=4439` exported and no env file: the env file says `PORT=4439`, the web answers
  there, `lsof -i :4327` shows nothing new.
- With a stub on the port answering `/api/v1/version` with the same version and no `instance` (P35-2): until it is
  fixed, the install reports success; after, it prints the foreign-port line.
- Before onboarding: `curl -s localhost:<p>/api/v1/health | jq .reason` → `"no_user"`, HTTP 200.
- `npm run test:a11y -- --port <p>` on a production mock build ends with `done in …s` and `0 new`; with
  `--scan-timeout 1` it must fail once P35-1 is in.
