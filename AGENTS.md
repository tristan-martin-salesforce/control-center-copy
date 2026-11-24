# Agent build protocol

How Claude sessions build this repo. The hard invariants are in [`CLAUDE.md`](CLAUDE.md) and the code rules in
[`CONTRIBUTING.md`](CONTRIBUTING.md); this page is the process. A tenet conflict ([`docs/TENETS.md`](docs/TENETS.md))
is always a `blocker`, never a workaround.

## Roles
- **Orchestrator:** one long-lived session. Owns the plan, the chunk ledger and the integration branch; dispatches
  builders, integrates their branches serially, talks to Tristan. Reads only the builders' returns, never their logs.
- **Builder:** one chunk, one git worktree, one `files:` glob. Sonnet by default (mechanical splits, parity moves,
  lint, docs, UI against a spec); Opus for `hard` chunks (engines, spend, Assistant, data-model migrations).
- **Reviewer:** a fresh session per wave, on the *diff*, not the narrative: tenets and invariants first, then the
  layer and length lint, then the tests that would catch a regression. Hard violations get fixed now; the rest
  become [`docs/BACKLOG.md`](docs/BACKLOG.md) rows.
- **Validator:** drives the real UI. Outbound stops at a draft or a dry run (*tenet: Draft, don't send*).

## A chunk brief
`id` · goal (one sentence, user-visible) · `files:` glob (the builder's whole write scope, tests included) ·
read-first (at most 5 files: the lane report, the living doc, the code) · acceptance (the observable result and the
test that proves it) · lane port if it runs the UI · model · depends-on.

## Builder rules
1. **Stay inside `files:`.** Need a file outside it? Make the smallest additive change only if the brief allows, and
   list it under `outside_glob`; otherwise return a `blocker` with the exact change you need. A contract change
   another chunk owns is always a blocker.
2. **Lane ports 4345-4399** for anything that runs the UI (`PORT=<lane port> npm run dev:web`; screenshots with
   `npm run shot -- <route> --port <lane port>`). Port 4327 belongs to the installed app. Stop your server when done. The installed app's state folder (`~/Library/Application Support/command-center/`) is the owner's live data: tests, dry runs and the ops scripts in a lane use `CC_STATE_DIR` or a `HOME` override, never the real one, and never load or unload the real LaunchAgents.
3. **Tests with the code**, co-located or in `tests/<module>/` (the folder is a `src/` module, never a chunk or lane
   name; a test that needs Postgres goes in `tests/db/<module>/`). Every behaviour change has a test. DB suites set
   `CC_TEST_DB_SUFFIX=<chunk id>` so parallel builders don't share a DB. Projects and where a test goes:
   `CONTRIBUTING.md` "Tests".
4. **Before returning:** `npm run check:fast` (typecheck + lint + the `unit` and `ui` projects; no new errors,
   warnings in your files explained), plus the DB projects you touched (`npm run test:db`, or one suite:
   `npm run test:db:worker`, `test:db:datasource`, ...). Commit small logical commits on your branch. Never push, never run
   `npm run release` or `npm run update` from a lane.
5. **Validated** means the real path ran to terminal success and the user-visible result is there (a test asserting
   it, or a screenshot you looked at). Exit 0 alone is not validation. Where live validation is impossible
   (connectors), say so and write the manual check for the owner.
6. **Never** send, post or write to an external system; never widen a read allowlist; never print or copy secrets;
   tests use fakes.
7. **Docs change with the code** (`CONTRIBUTING.md` "Docs change with the code"). `docs/DECISIONS.md` and
   `docs/decisions/` change only when the brief says so.

## Return format
```
{chunk, status: built|partial|failed, branch, sha, files: [...], outside_glob: [...], deps_added: [...],
 verify: "<commands run + results, incl. test counts>", manual_checks: [...], docs_updated: [...],
 blockers: [...], notes: "<≤10 lines: decisions you made, anything the integrator must know>"}
```

## Parallel lanes
- Lanes own modules or domain files, not shared hubs. If two chunks need the same file, sequence them, or give each
  one clearly delimited block (as in `eslint.config.mjs`).
- **The DataSource is split by domain (R7):** a lane owns its domain's `src/server/datasource/{db,mock}/domains/<domain>.ts`,
  `types/<domain>.ts` and `src/server/views/<domain>.ts`. The facades (`db/index.ts`, `mock/index.ts`: one delegate per
  route), the contexts (`db/ctx.ts`, `mock/ctx.ts`) and `types.ts` are shared seams: one-line additive edits only.
- **A lane that touches more than two modules splits into chunks.**
- Shared seams (`src/contract/routes.ts`, the DataSource interface, `package.json`) are changed by the orchestrator or
  by one designated chunk per wave.
- Migrations are numbered by the orchestrator in the brief; each is additive and has its drizzle journal entry
  ([D-96](docs/decisions/0096-migration-discipline.md)).
- Each wave ends with a review on the integrated diff and the eval harnesses green (golden cases, golden days,
  parity) before the next wave starts.

**Machine load.** Before a wave with more than one builder, start `npm run load:guard -- --start` (log in `~/Library/Logs/load-guard.log`). It renices build and test processes when the load is high and pauses the heaviest process group when memory is critical, resuming them when the machine is calm; it never touches Claude Code, Postgres or your apps. `--once` shows what it would manage; `--stop` resumes everything and exits. Builders still run one heavy command at a time.

**Quota.** The orchestrator keeps `npm run usage:guard` current: `--mark <percent> --hours-left <h>` when the user reports usage, `--spent <tokens> <chunk>` from every builder's completion notification, and `--status` before each dispatch; it prints the model tier to use from the projected usage at the deadline (under 90 → spend more: opus everywhere and more in parallel; to 100 → on track; over → sonnet, then haiku, then stop). The goal is to land at 100 at the deadline with the work finished, not to save tokens.
