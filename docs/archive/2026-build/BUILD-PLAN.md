# UI pivot: build plan (waves, chunks, ownership)

The orchestrator owns this file. Every builder reads `CLAUDE.md`, `docs/archive/2026-build/REQUIREMENTS.md`, `docs/archive/2026-build/UI-SPEC.md`, `docs/reference/DATA-MODEL.md`, and this file.

## Rules for every builder

1. **Hard invariants** from `CLAUDE.md`:
   - never send, post or write to Slack, Gmail, Calendar, Drive, Org62 or VDP;
   - call read tools only;
   - never print, log or commit tokens, cookies or passwords.

   Builders may run read-only connector calls for testing, capped at $1 of LLM spend per chunk.
2. **Ownership.** Stay inside your chunk's `owns:` globs. Files outside them are read-only to you. If you need a contract change (`src/contract/**`, `src/server/ports.ts`, `src/db/schema.ts`), stop and return `blocker`, unless your chunk owns that file.
3. **Dependencies.** Wave 0 installs every anticipated dependency. Add a dependency only if it's essential, and list it in your return so the orchestrator can reconcile `package-lock.json`.
4. **Commit on your branch.** Make small, conventional commits ending with:
   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```
   Don't merge, rebase onto main, or push.
5. **Verify for real.** Run `npm run check`, which must pass. Frontend chunks also take screenshots with `npm run shot -- <route> [--widths 1280,1440,1920,2560]` and **look at them** (Read the PNGs) before returning. "Validated" means you saw the result.
6. **Ports.** Frontend chunks run `PORT=<lane port> npm run dev:web`. Lanes 4345–4352 are reserved in `~/Projects/PORTS.md`. Kill your server before returning.
7. **Databases.** Backend chunks use their own database, `control_center_<chunk>`, created with `/opt/homebrew/opt/postgresql@17/bin/createdb`; the `psql` on PATH is v16, so use the v17 binaries. Never use the `control_center` database. That one is the orchestrator's integration DB.
8. **Private data.** Real fixtures live only in `~/Library/Application Support/control-center/`. Don't copy customer names into committed files; use placeholders in tests and examples.
9. **Return format.**
   ```
   {chunk, status: built|failed, branch, sha, files, verify: "<cmd + result>", screenshots: [...], deps_added: [], blockers: [], notes}
   ```

## Waves

| Wave | Chunk | Model | Owns (globs) | Depends on |
|---|---|---|---|---|
| **0** | **W0 foundation:** scaffold, deps, brand-asset sync, contract, ports, mock DataSource (in-memory store, versioning, audit/undo, scenario clock) + every API route, scripts (`shot`, `check`) | Opus | everything at creation; afterwards `src/contract/**`, `src/server/ports.ts`, `src/server/datasource/types.ts`, `package.json` are orchestrator-owned | — |
| 1 | **FE-1 shell + design system + Today** | Opus | `app/(shell)/**`, `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `public/fonts/**`, `src/components/**` (except the subfolders owned by wave 2), `src/ui/**`, `src/client/**`, `src/mock/dev-toolbar/**` | W0 |
| 1 | **SEED real seed** | Sonnet | `~/Library/Application Support/control-center/fixtures/**` (outside the repo), `scripts/seed/**` | W0 contract |
| 1 | **BE-1 schema + data layer + worker runtime** (schema from `docs/reference/DATA-MODEL.md`) | Opus | `src/db/schema.ts`, `src/db/repo/**`, `src/db/migrations/**`, `drizzle.config.ts`, `src/worker/runtime/**`, `src/worker/index.ts`, `src/server/datasource/db/**`, `src/server/events/**`, `src/server/audit/**`, `tests/be1/**` | W0 |
| 0∥ | **BE-0 schema**: DATA-MODEL §3 split by domain, migrations, change-set helper, versioning/lock guards | Opus | `src/db/**`, `drizzle.config.ts`, `tests/be0/**`, `docs/reference/DB-NOTES.md` | — (runs alongside W0) |
| 0∥ | **BE-2a scanner runtime + traversal skills**: SkillRunner (Agent SDK), `cc` tools, scheduler/resume/reconcile, in-memory store, `scan-slack`/`scan-org62` | Opus | `src/scanner/{runtime,reconcile}/**`, `src/scanner/store-memory.ts`, `src/scanner/index.ts`, `src/llm/**`, `skills/_scanner-common.md`, `skills/scan-{slack,org62}.md`, `tests/be2a/**` | `src/scanner/types.ts` |
| 0∥ | **BE-2b deterministic fetchers**: devbar Google client, Gmail/Calendar/Gemini/Drive (+digest/diff), Claude sessions watcher, trainings, watch scope + skills | Sonnet | `src/connectors/**`, `src/scanner/drive-digest/**`, `skills/scan-{gmail,calendar,gemini-notes,drive,claude-sessions,trainings,watch}.md`, `tests/be2b/**` | `src/scanner/types.ts` |
| 0∥ | **LIB-compose**: TipTap → Slack mrkdwn/blocks/email HTML/plain, profiles, lossy notes, parsers, payload = preview | Sonnet | `src/lib/compose/**`, `tests/compose/**` | — |
| 0∥ | **TOOLS**: ToolAdapter manifests + adapters (talk-track, pulse-footprint, estimator), Claude launcher + context pack, repo resolver | Sonnet | `src/tools/**`, `tools-registry/**`, `tests/tools/**` | — |
| 0∥ | **SKILLS-NBA**: NBA/draft/brief/enrich skills, prompt builders, voice profile, eval set | Opus | `skills/{nba,draft,brief}-*.md`, `skills/enrich-capture.md`, `src/engines/{nba,briefs}/prompt/**`, `src/engines/voice/**`, `tests/skills/**` | — |
| ~~1~~ | ~~BE-2 scanner runtime per `docs/reference/SCANNER.md`~~ (now split into BE-2a + BE-2b above): connectors, Agent SDK runner, `cc` tools, all `scan-*` skills, cursors/coverage/resume/reconcile, Claude-session watcher | Opus | `src/connectors/**`, `src/llm/**`, `src/scanner/**`, `skills/scan-*.md`, `tests/be2/**` | W0 ports, BE-1 schema (coordinate via `src/db/schema/*`; BE-2 reads it and doesn't edit it) |
| 2 | FE-2 item detail + composer + initiative | Opus | `app/work/[id]/**`, `app/initiatives/**`, `src/components/detail/**`, `src/components/composer/**`, `src/lib/compose/**` | FE-1 |
| 2 | FE-3 chat dock | Opus | `src/components/chat/**`, `src/mock/chat-script.ts` | FE-1 |
| 2 | FE-4 Work + Triage + Outbox + Briefs | Sonnet | `app/work/page.tsx`, `app/work/_*/**`, `app/triage/**`, `app/outbox/**`, `app/briefs/**`, `src/components/lists/**`, `src/components/briefs/**` | FE-1 |
| 2 | FE-5 Deals + Agents/Tools | Sonnet | `app/deals/**`, `app/agents/**`, `src/components/deals/**`, `src/components/agents/**` | FE-1 |
| 2 | FE-6 Time + Health + Settings | Sonnet | `app/time/**`, `app/health/**`, `app/settings/**`, `src/components/time/**`, `src/components/health/**`, `src/components/settings/**` | FE-1 |
| 2 | BE-3 engines: closure (signals → state), reopen/sibling, priority + policy, re-eval orchestrator (extract/link lives in the BE-2 scanner) | Opus | `src/engines/{extract,closure,priority,reeval}/**`, `skills/engines/**`, `tests/be3/**` | BE-1, BE-2 |
| 2 | BE-4 NBA + drafts + outbox send adapters | Opus | `src/engines/nba/**`, `src/outbox/**`, `tests/be4/**` | BE-1, BE-2 |
| 3 | BE-5 Org62 missed-opp + activity logging + canvas sync + briefs (channel + opp digests, relevance) | Opus | `src/engines/{deals,activity,briefs}/**`, `skills/briefs/**`, `tests/be5/**` | BE-1, BE-2 |
| 3 | BE-6 chat backend + tool adapters + Claude launcher | Opus | `src/chat/**`, `src/tools/**`, `src/engines/sessions/**`, `tests/be6/**` | BE-1, BE-4 |
| ★ | **Mock review with Tristan** (after the FE wave 2 merge) | — | — | FE-1…6 |
| 4 | WIRE: `CC_DATA=db`, end-to-end tests, fixes from review | Opus | by assignment | all |

Frontend lane ports: FE-1 4345, FE-2 4346, FE-3 4347, FE-4 4348, FE-5 4349, FE-6 4350. Backend lanes 4351 and 4352 are spare.

## API surface (W0 creates all routes, served by the mock DataSource)

All routes are under `/api/v1`. JSON responses validate against `src/contract`. Mutations take `ifVersion` and return the updated entity plus an `auditId` for undo.

| Method + path | Purpose |
|---|---|
| `GET /today` | The whole Today payload: header facts, day spine, Now (top 3), more-today rows, shelves, rail lanes, rank meta |
| `GET /items?tab&filter…` · `GET /items/:id` · `POST /items` (capture) · `PATCH /items/:id` · `POST /items/:id/actions/:verb` (done, snooze, accept, dismiss, confirm-done, reopen, not-now) | Work items |
| `GET /items/:id/evidence` · `GET /items/:id/history` · `POST /items/:id/seen` | Detail tabs and new markers |
| `GET /initiatives/:id` | Initiative page |
| `GET /items/:id/nba` · `POST /nba/:id/regenerate` · `POST /proposals/:id/{apply,reject}` | NBA and proposals |
| `GET /drafts/:id` · `PATCH /drafts/:id` (autosave) · `POST /drafts/:id/preview` · `POST /drafts/:id/dispatch {mode: draft\|send, confirmToken}` | Composer and Outbox |
| `GET /outbox` | Outbox page |
| `GET /calendar?from&to` | Spine and Time |
| `GET /agents` · `POST /agents/launch` (returns the `claude://` URL and the run record) · `POST /agents/:id/answer` · `POST /agents/:id/cancel` | Agents |
| `GET /tools` · `POST /tools/:id/runs` · `GET /tool-runs/:id` | Plugin seam |
| `GET /time?week` · `PATCH /activity/:id` · `POST /activity/sync-canvas` | Time |
| `GET /deals` · `GET /deals/:accountId` · `GET /deals/missed` · `POST /deals/missed/:id/{claim,dismiss}` | Deals |
| `GET /briefs` · `GET /briefs/:id` · `POST /briefs/highlights/:id/{promote,task,dismiss}` · `GET/POST/PATCH /watches` | Briefs and watch subscriptions |
| `GET /triage` · `POST /triage/:id/{accept,dismiss,merge}` | Triage |
| `GET /health` · `POST /connectors/:id/{reauth,scan}` · `GET /scans` · `GET /jobs` · `POST /jobs/:id/retry` · `GET /events/log` · `POST /events/log/:id/ack` | Health |
| `GET /settings` · `PATCH /settings/:section` · `POST /policy/preview` · `POST /policy/apply` · `GET /policy/versions` | Settings and policy |
| `POST /audit/:id/undo` | Universal undo |
| `GET /search?q` | ⌘K |
| `GET /chat/threads` · `GET /chat/threads/:id` · `POST /chat` (SSE) | Chat |
| `GET /events` (SSE) | Live invalidation `{topic, ids, reason}` and scenario events |
| `GET /since?ts` | "Since you left" digest |
