# Build brief for every builder (holistic review build, 2026-11-20/21)

You are one builder in a parallel, orchestrated build. The orchestrator reads only your final return, so be exact. Read first: `CLAUDE.md`, `docs/TENETS.md`, this folder's `README.md` (sections 2, 5 and 8: the findings, the plan and the binding decisions) and the lane report your chunk cites.

## Environment
- You run in your own git worktree (a branch off the integration branch). Your cwd is that worktree; never `cd` to another checkout. Never push.
- `node_modules` is not in your worktree. First command: `ln -s /Users/tristan/orca/workspaces/control-center-copy/kraken/node_modules node_modules` (fast; the integration checkout has the full install). If your chunk adds a dependency, do NOT symlink: run `npm ci --no-audit --no-fund` and then `npm install <pkg>` so `package.json` and the lockfile change in your worktree, and list the dependency in your return.
- Node here is 25.4 (`.nvmrc` will say 22). The repo's tests must pass on both. Postgres 17 is installed via Homebrew: `export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH`; check `pg_isready`. If it is not ready yet (still installing), do everything else first and re-check. DB suites: `npm run test:db`, `test:be1a`, `test:be1b` create their own databases; set `CC_TEST_DB_SUFFIX=<your chunk id>` so parallel builders don't share a database.
- Mock web server for screenshots: `CC_DATA=mock PORT=<your lane port> npm run dev:web`; `npm run shot -- <route> --port <port>`. Lane ports are assigned in your chunk brief. Run `node scripts/sync-brand-assets.mjs` first if you need icons. Stop the server when done.
- No external systems, ever: no Slack, Gmail, Drive, Calendar, Org62, VDP, no MCP calls, no `claude -p` runs against real sources, no network sends. Tests use fakes. Never print or copy credentials.

## Rules
- Stay inside your chunk's `files:` glob. If you must touch a file outside it, do the smallest additive change, list it under `outside_glob` in your return, and say why. If you need a contract change another chunk owns, stop and return a `blocker`.
- `package.json`: only the lines your brief allows (scripts/engines/dependencies named in it). The orchestrator resolves conflicts.
- Migrations: additive only, numbered as your brief says, with a drizzle journal entry; a backfill is a job or an idempotent SQL statement, never destructive. `PROJECTIONS_VERSION` bumps only when your brief says so.
- Tenets are invariants. Cite them by name. *Nothing leaves without approval*, *Read-only ingest*, *Hours are human hours*, *Suggest, then learn*, *Provenance on everything*, *Local data, privacy-safe logs*, *Config over code*. A conflict is a `blocker`, never a workaround.
- Product name in NEW user-facing text: **Command Center**. Do not rename existing strings; a final chunk does the rename everywhere.
- Tests: write them with the code, co-located (`src/<module>/**/x.test.ts`) or in the matching `tests/<module>/` folder, never in a folder named after your chunk. Every behaviour change has a test. Keep `tests/setup/ledger-gaps.ts` green (every booked model call has its audit fields).
- Docs: a behaviour change updates the living doc in the same commit (README, docs/UX.md, docs/ARCHITECTURE.md where they describe it). Do not edit `docs/DECISIONS.md`; the docs-reset chunk owns it.
- Logging: ids, statuses, timings, error codes. Never message bodies or tokens.
- "Validated" means the real path ran and the user-visible result is present (a test asserting it, or a screenshot you looked at). Exit 0 alone is not validation. Where live validation is impossible here (connectors), say so and write the manual check the owner runs on the work machine into your return.

## Before you return
1. `npm run typecheck` and `npm run lint` clean for your files (the repo-wide baseline may have pre-existing failures in `sample-data/**` until chunk p0-ops-safety lands; report those separately, don't fix them unless they are yours).
2. `npm test` green, plus the DB suites your chunk touches.
3. Commit on your branch, small logical commits, each message ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Report the branch name and final sha.

## Return format (exactly this, as your final message)
```
{chunk, status: built|partial|failed, branch, sha, files: [...], outside_glob: [...], deps_added: [...],
 verify: "<commands run + results, incl. test counts>", manual_checks: ["<what the owner must verify live>"],
 docs_updated: [...], blockers: [...], notes: "<≤10 lines: decisions you made, anything the integrator must know>"}
```
