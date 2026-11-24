# 34 · Review of the post-2.0 wave, part 3 (`04b3b66..fb7c5b6`)

Fable fork, 2026-11-21 evening. Review only; nothing fixed here. Scope: every merge after review 33 (agentic booking, help
per persona, the review-33 fixes, the build engine check, the status addendum, the accessibility pass and its leftover,
the onboarding salvage and follow-ups, the relay flake, claim owner and claim required, the install walk fixes). The
two lanes still landing (`post-a11y-last`, `post-install-walk-2`) were not reviewed.

## Summary

**Blockers: 0. High: 0. Medium: 1. Low: 3. Info: 2.**

| # | Sev | Where | What |
|---|---|---|---|
| P34-1 | M | `scripts/ops/update.mjs:160,171`, `scripts/ops/setup.mjs:120`, `scripts/ops/install.mjs:173` | ON-14 is fixed in `release-wiring.mjs` only: the repo update path and setup still let the shell's `PORT` win, so `npm run update` with `PORT` in the shell health-checks the wrong port and treats a good update as failed. **Fixed** in `2766f58`: `update.mjs` reads `servicePort()`, setup's `onboardingUrl` lets the file win, `install.mjs` uses `deps.port()`; pinned in `tests/ops/install-walk-fixes.test.ts` |
| P34-2 | L | `STATUS-2.0.md` §6.4 | still says SEC-12 and SEC-14 "go to the release owner"; both are fixed (`2cb9011`, `df74398`) |
| P34-3 | L | `src/worker/recovery.ts:176-203` | two workers of one user starting together can book the same interrupted pass twice (read-then-insert, pre-existing; the new turn→pass step is idempotent on its own side). **Fixed** in `f480868`: a per-run advisory lock held until the booking commits (no migration: `request_hash` is not unique by design); the drill books once with two concurrent recoveries |
| P34-4 | L | `scripts/ops/install.sh:165`, `scripts/ops/install.mjs` | an uncaught error in `install.mjs` prints a raw stack trace, then install.sh says "the lines above say why" (the walk's open note). **Fixed** in `b0134f1`: `uncaughtException` / `unhandledRejection` print one line (the message, the doctor command) and exit 1 |
| P34-5 | I | `src/client/chat/turn.ts:1-5` vs `src/llm/chat/router.ts:171` | the step-limit code is spelled twice (client and server); nothing pins them equal. **Fixed** in `e510ce1`: `tests/llm/chat/step-limit-code.test.ts` imports both and the catalog |
| P34-6 | I | `scripts/ops/lib/update-from.mjs:22` | the printed update prompt hard-codes `$HOME/Library/Application Support/…`; a `CC_STATE_DIR` install prints a path that is not its own. **Fixed** in `b0134f1`: the prompt uses `npmInCurrent('update', env)` |

## Findings

### P34-1 (Medium) `PORT` precedence is fixed in the release wiring, not in the repo update or setup
- **Where:** `scripts/ops/update.mjs:160` (`runningVersion`) and `:171` (`waitForApp`): `Number(process.env.PORT || 4327)`; `scripts/ops/setup.mjs:120` (`onboardingUrl`): `Number(env.PORT ?? fileEnv.PORT) || 4327`; `scripts/ops/install.mjs:173`: `Number(readEnvFile(envFilePath())?.PORT) || 4327` (file only, never the shell).
- **What is wrong:** ON-14 (`20-onboarding-dry-run.md`) established that the env file wins, and `df7711f` made `effectiveEnv` / `servicePort` (`scripts/ops/lib/release-wiring.mjs:88-93`) do exactly that for the release install, the plists, the health wait and the printed URL. The repo update (`npm run update`, the path a 1.x install takes) still resolves the port the old way: with `PORT=4345` in a shell (a dev lane, a teammate who exported it once), `waitForApp` polls `:4345` while the LaunchAgent serves the env file's `4327`, the update reports a failure and puts the old build back (`docs/RELEASING.md`: "a failure after the switch puts `current` back"). `setup.mjs` prints an onboarding URL on the shell's port for the same reason. `install.mjs:173` has the opposite half: it ignores a shell `PORT` when the env file has none.
- **How to verify:** `PORT=4399 npm run update -- --dry` from a checkout whose env file says `PORT=4327`: the health step names `:4399`. Unit: `onboardingUrl({ PORT: '4327' }, { PORT: '4399' })` should give `:4327`.
- **Smallest fix:** import `servicePort` / `effectiveEnv` from `release-wiring.mjs` in all three and use `servicePort(process.env, readEnvFile(envFilePath()))`; extend `tests/ops/install-walk-fixes.test.ts` with the three call sites.

### P34-2 (Low) STATUS-2.0 §6.4 hands over two items that are done
- **Where:** `docs/reviews/2026-11-20-holistic/STATUS-2.0.md` §6.4: "SEC-12 and SEC-14 (two one-line checks in `scripts/ops/**`) go to the release owner".
- **What is wrong:** SEC-14 landed in the salvage (`2cb9011`) and SEC-12 in the follow-ups (`df74398`: `isInstallableVersion`, the downgrade refusal, `--allow-downgrade`); `17-security-review.md` marks both. §6.4 is the list Tristan reads on the work machine.
- **Smallest fix:** drop them from §6.4; say in §6.1's onboarding bullet that SEC-12/14 landed.

### P34-3 (Low, pre-existing) Two workers of one user can book an interrupted pass twice
- **Where:** `src/worker/recovery.ts:176-203` `bookUnbookedPasses`: selects pass rows with `not exists (select 1 from llm_calls where request_hash = 'pass:<run>:<seq>')`, then inserts through `store.recordSpend`.
- **What is wrong:** the read and the insert are not one statement. Two workers for the same user starting in the same second (a crash-loop restart racing a manual start) both see the rows unbooked and both book them. `passRowsOfInterruptedQueries` (`:212-222`) is safe on its side (`on conflict (run_id, seq) do nothing`, and the `not exists … q` guard), so the new code did not widen this; the window is the old one. A one-worker install cannot hit it, which is why it is Low.
- **How to verify:** run two `recoverAtStart` calls for the same user concurrently on a database with one interrupted run (the crash-drill harness); count `llm_calls` rows for the run.
- **Smallest fix:** a unique index on `llm_calls(request_hash)` with `on conflict do nothing` in `recordSpend` for `pass:` hashes (check `src/db/migrations` first for an existing one), or `pg_advisory_xact_lock(hashtext(run.id))` around the booking.

### P34-4 (Low) `install.mjs`'s uncaught errors still print a stack trace
- **Where:** `scripts/ops/install.sh:165` runs `install.mjs … || die "the install stopped (the lines above say why and what to run)."`; nothing in `install.mjs` catches an error thrown outside `installRelease`'s own failure paths (ON-2 had exactly this shape: `ERR_MODULE_NOT_FOUND` with a stack).
- **What is wrong:** the walk's first attempt showed a Node stack under a line that promises plain words. Every other stop in the install says what happened, that nothing changed, and the one thing to do (`docs/INSTALL.md` "If the installer stops").
- **Smallest fix:** at the top of `install.mjs`, `process.on('uncaughtException')` and `process.on('unhandledRejection')` print one line with the error's `code` or class (never its message) and `npmInCurrent('doctor')`, then exit 1. Test with a thrown `ERR_MODULE_NOT_FOUND`.

### P34-5 (Info) The step-limit code is spelled in two places
- `src/client/chat/turn.ts` `STEP_LIMIT_CODE = 'RATE.CHAT.STEP_LIMIT'` duplicates `src/llm/chat/router.ts:171` (the client must not import `src/llm`, so a copy is the right shape). Nothing pins them equal; a hygiene test that reads both, or one export from `src/contract`, would. Harmless today.

### P34-6 (Info) The update prompt prints the default state folder
- `scripts/ops/lib/update-from.mjs:22` prints `npm --prefix "$HOME/Library/Application Support/${STATE_FOLDER_NAME}/releases/current" run update …`. With `CC_STATE_DIR` set (dry runs, a moved state folder) the pasted command names a folder that does not exist. `npmInCurrent` (the salvage's helper) already derives the real path.

## Verified OK (on fb7c5b6)

- **Invariants.** No change under `src/connectors/**` or the MCP wrapper (empty diff); no new sender; `git ls-files | grep -E "node_modules|^\.shots|^dist/"` is empty; the walk report quotes no credential-like text (bearer / cookie / password / `token=` / secret / `sid=`: none); `launchctlBin()` is `/bin/launchctl` only when `CC_LAUNCHCTL` is unset, and every path helper honours `CC_STATE_DIR` / `CC_LAUNCH_AGENTS_DIR` / `HOME` (`paths.mjs:11-15`; `install.sh:169` falls back to `CC_STATE_DIR`).
- **Queue.** `claimJobs` has one caller (`src/worker/runtime.ts:294`, passes `this.o.userId`); `ownerUserId` is required (`queue.ts:16`); the owner is a filter on `jobs_dequeue_idx` (comment `:115-117`, the lane's `EXPLAIN`); the spend continuation's requeue and cancel filter on `owner_user_id` (`spend.ts:265,271`); the relay guard enqueues through the job's own context.
- **Recovery.** Order at start: `closeInterruptedRuns` (turn→pass, book, close with `finished_at = now`) then `releaseDeadHolds` with the same `now`, so its one-hour `since` window always holds the runs it just closed (`recovery.ts:90-96, 157-159, 245-251`). Turn rows are summed nowhere but there: `store-db.ts:92` and `trace/queries.ts:494` read `kind = 'pass'` only, so the Health ledger and `scan:trace` do not double count; a finished query keeps one `llm_calls` row.
- **Worker wait.** `waitForUser` beats every `HEARTBEAT_INTERVAL_MS` while really waiting (the wait is the worker's state, not a mask); `HeartbeatWriter.beat` swallows disk and `onBeat` failures (`heartbeat.ts:120-129`), so a failing beat cannot crash the wait.
- **Retention.** `cutoff` clamps at AD 1 with the reason in the comment; one failing rule leaves the others running, writes one `DATA.RETENTION_RULE_FAILED` row per rule (fingerprint upsert, count bumped on repeats, resolved by the rule's next clean run); the dry path counts only.
- **Chat Continue.** Only a step-limit stop gets the Continue label and the continuation (`isStepLimitError`); any other error retries as before (`step-stop-continue.dom.test.ts:118`); the continuation targets the stopped answer by id, live or after reconcile.
- **Install and ops.** `isInstallableVersion` accepts plain semver only, no `..`; the downgrade is refused before anything moves, with `--allow-downgrade` plumbed through `install.sh` (bash 3.2 `case`), `install.mjs` and `update --from`; `restartAgents` waits for `health` (90 s, every 2 s) before "started"; `install.sh`'s inline feed program is cut out of the script and run against `parseFeed` by `tests/release/install-sh-feed.test.ts`; the `worker-error` check maps the worker's short codes to catalog entries and warns `BUG.UNKNOWN` on an unknown one, skipping when the heartbeat says stopped or dead; `pasteableStep` rewrites every `npm run <script>`; `/api/v1/version` answers before a user with the default persona and nothing else keyed on the user (`versionSettings`).
- **Build.** `engineGate` checks the pinned version for the running arch (both arches pinned at `17.12.0-beta.19`), the three binaries, refuses a symlinked `node_modules` (`lstatSync`), labels `--allow-no-engine` builds with `NO-ENGINE.txt`, and the smoke reads it back. `node scripts/release/build.mjs --check-engine`: ok.
- **Tests.** ENG-5 bounds unchanged (`engine-fanout.test.ts`: 0 lines changed; direct 55 / total 140); the 15 new test files use `waitFor` conditions, no sleeps or real timers; `relay-holds.spec.ts` keeps a stranger's due job on every real queue as the owner-filter guard and cancels them in `afterAll`.
- **Runs.** `npm run typecheck` 0 errors; `npm run lint` 0 errors, 0 warnings; `CC_TEST_DB_SUFFIX=review34 npx vitest run --project db-worker` 12 files, 125 passed; `npm run test:evals` 390 passed, 1 skipped; `npm run scan:private -- --no-db --no-history` 201 tracked files with id-shaped placeholders (P33-4, unchanged).
- **Docs.** The seven CHANGELOG lines added today match the code they name (step-stop continue, mid-query booking, goldens 390, engine gate, a11y, install walk, owner filter). `20-onboarding-dry-run.md`'s "Fixed in" shas exist on the branch and name the right files. `docs/INSTALL.md`'s message table matches `install.sh`'s `die` strings.

## STATUS-2.0 §6 must also say

1. §6.4: SEC-12 and SEC-14 are done (P34-2); what stays Tristan's is SEC-7, D-86, the DB-backed `scan:private`, the snapshot push.
2. §6.5 with the final tree's numbers (at fb7c5b6: typecheck 0; lint 0/0; `db-worker` 125; evals 390; the full `npm test`, `test:db`, both crawls and the rebuilt tarball's sha from the final run).
3. §6.1: fill the two placeholders once `post-a11y-last` and `post-install-walk-2` land; the walk's verdict belongs in §6.1's onboarding bullet.
4. §6.3: after P34-1, "`npm run update` with `PORT` set in the shell still reaches the app on the env file's port".

## Manual checks for the work machine

- `PORT=4399` exported in the shell, then `npm run update` from the 1.x checkout: the health step waits on the env file's port and the update does not roll back (after P34-1).
- The installer stopped by hand (rename `scripts/ops/lib/db-agent.mjs` in an unpacked copy): one plain line and the doctor command, no stack (after P34-4).
- The agentic SIGKILL check from §6.3, then a second `launchctl kickstart` of the worker within a minute: `llm_calls` for the run does not grow (P34-3's window).
- `npm run doctor` while the worker waits for onboarding: the heartbeat line is fresh and the "Worker's last error" line reads `none`.
