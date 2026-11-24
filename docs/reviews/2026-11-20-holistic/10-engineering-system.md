# 10 — Engineering system (asks #9, #10, #11): structure, testing, refactor path, docs

Reviewer lane: ENG. Read-only review of the tree at `3533cb6` (2026-11-20). Measurements were taken on this machine
(Node v25.4.0, no Postgres). Every number below comes from a command I ran. Where I did not verify something, I say so.

## 1. Summary

1. **`npm run check` is red on HEAD and on a fresh machine, for reasons unrelated to the app.** `typecheck` fails on 16
   errors and `lint` on 140 errors, all but two in `sample-data/generators/**`: the last commit added it, and both
   tools cover `**/*.ts`. The unit suite has 59 failing tests. 48 of them fail only because Node 25 ships a global
   `localStorage` that shadows jsdom's (`brew install node`, which README.md:10 recommends, installs 25). 5 DB files
   error instead of skipping when `psql` is missing, and 1 test is a real regression (THR-1). Fixing these is the first
   item. Without it, no other rule means anything.
2. **The hot spots are the result of the lane protocol.** BUILD-V2 told every lane to make "one-line, additive" edits to
   the shared DataSource index files (docs/ui/BUILD-V2.md:67). Those files are now 4,779 lines (db) and 4,166 lines
   (mock), and they are near line-for-line twins: both run the same code over an `all(collection)` read model. A
   domain split behind the unchanged 146-method `DataSource` interface removes the hot spot, and the parity suite
   already exists to guard it.
3. **The tests are laid out by build lane, not by module.** There are 50 folders (`p1`…`p5`, `be0`…`bereeval`,
   `lanec`, `w0`, `integrate1`), with 353 test files and ~67k lines. One run costs 46 s wall, and 274 s of the CPU time
   is spent *collecting* (the import graph); only 60 s runs tests. A leaf change such as `engines/activity/overlap-flags.ts`
   fans out to 125 of 315 files through `vitest related`, because 143 tests reach the whole app through a DataSource.
   Vitest `projects`, per module, gets a module run to about 4 s. A smarter "affected" runner does not, until the hubs
   are cut.
4. **Layering is mostly sound, but it has no name and no lint.** UI code never imports server code except in tests.
   The real core, `src/server/datasource/db/store/*`, is imported by jobs, projections, scanner and llm, and the
   production db path imports from `mock/`. A layer table plus `no-restricted-imports` (eslint-plugin-import is already
   installed) and a `max-lines` rule with a grandfather list together make up the whole "light rules" set.
5. **The docs are build-era and do not show what is current.** ARCHITECTURE.md still says "proposed" and SQLite.
   DECISIONS.md is 66 KB in 109 lines, with rows up to 5,313 characters. docs/README.md says "42 decisions"; there are
   75. docs/ui holds 17 build specs (DATA-MODEL.md alone is 5,693 lines). A three-tier doc set (living / reference /
   archive) with short ADR files fixes this cheaply.

## 2. How it works today

| Area | Where | Notes |
|---|---|---|
| Size | `src/` 21 dirs, 1,127 files; `app/` 194 files; 226,440 lines | components 72.5k, server 41.4k, engines 23.6k, scanner 11.1k, app 10.5k, contract 9.2k |
| File length | 1,321 files: 110 > 400 lines, 67 > 500, 42 > 600, 17 > 800, 11 > 1,000, 7 > 1,200 (non-test counts for 500/600/1,000) | The top 7: db/index 4,779; mock/index 4,166; scanner/store-db 2,540; projections/run 1,624; engines/home/build 1,500; scanner-runtime 1,343; store-memory 1,267 |
| API | `src/contract/routes.ts` (149 routes, 136 paths) → `scripts/gen-api-routes.ts` → `app/api/v1/**/route.ts` (137 files incl. the `[...unknown]` catch-all) → `handle(key)` in `src/server/http.ts:2` → `getDataSource()[key]` | The generated files match the table (verified by count and header). The generator never deletes stale route files and no test checks drift |
| DataSource | `src/server/datasource/types.ts:17` (146 methods) · `index.ts:2-3` imports **both** implementations statically · `db/index.ts:350` `class DbDataSource` (169 methods, 146 imports, 165 `this.model()` calls) · `mock/index.ts` (166 methods) | db reads a per-user `ReadModel` (`db/model.ts:121`) with the same `all/get/settings/meta` surface as the mock `Store` (`mock/store.ts:195`), so method bodies are twins (compare `getDeals` in both) |
| Shared repo layer | `src/server/datasource/db/store/*.ts` (27 files) + `ids`, `ext`, `enums`, `seed` | Imported by `src/jobs/handlers/*` (72 imports from `server`), `src/projections/run.ts`, `src/scanner/store-db.ts`, `src/llm/readin/planner.ts`. It is the real data-access core, but it sits under `server/datasource` |
| Tests (unit) | `vitest.config.ts:12-24`: `tests/**`, `src/**`; excludes `tests/be0`, `tests/be1b`; global setup `tests/setup/ledger-gaps.ts` (an audit-field invariant on every booked model call) | 315 files run, 3,682 tests. Of 353 test files: 69 need Postgres, 74 use the mock DataSource, 15 render with jsdom, 195 are pure. 59 are co-located under `src/` (components 43, client 11) |
| Tests (DB) | `test:db` (be0), `test:be1a`, `test:be1b`, `test:bereeval`, each with its own `vitest.config.ts` + `global-setup.ts`; another ~18 `*-db.test.ts` files in the root suite gate themselves | The Postgres bootstrap (`PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin'`, `createdb`) is copy-pasted in 22 files (e.g. `tests/trace/db.test.ts:37-54`); `tests/stress/helpers/pg.ts` exists but is not reused |
| Parity | `tests/be1b/parity-reads.test.ts` (65 reads, both sources, contract-valid, equal; again after reversing row order), `parity-mutations.test.ts`, `tests/be1a/store-conformance.ts:64` (one scenario set for the memory and db scanner stores) | This is the right pattern, but it runs only with Postgres, and `npm run check` needs Postgres |
| Guardrail tests | `tests/guardrails/unread-fields.test.ts` (every exported derive field has a reader), `pending-never-done.test.ts`, `tests/be2b/google-client.test.ts:38` (allowlist), `tests/be2b/skills-and-fixtures.test.ts:39,91,100` (skills declare read tools only; fixtures are placeholders), `tests/hygiene/job-kinds.test.ts`, `scan:private` | Good, but scattered. Nothing statically checks that no code outside `src/outbox/**` and `src/connectors/**` reaches `fetch`/`child_process`; today that holds by inspection (see ENG-9) |
| Evals | `tests/skills/evalset.test.ts` (prompt builders + validators vs `tests/fixtures/skills/golden/*.json`), `tests/bereeval/**` (DB) | `sample-data/` (155 entries, CAST docs) is not used by any test yet |
| E2E / UI smoke | `playwright.config.ts:7` → `e2e/`, which **does not exist**; `scripts/qa/crawl.mjs` (every page; console errors, 4xx, missing pages; `--mock`/`--live`); `npm run shot` | The crawl is the de facto smoke test, but it is not in `check` |
| Lint | `eslint.config.mjs`: next/core-web-vitals + next/typescript, one unused-vars rule | No boundaries, no `max-lines` |
| Build protocol | `docs/PLAN.md:180-197` (orchestrator, builders per chunk in worktrees with `files:` globs, serial cherry-pick, a reviewer per wave); `docs/ui/BUILD-V2.md:55-67` (lane → port 4345-4356 → glob table); `CLAUDE.md` invariant 4 + Builder return format; `.claude/launch.json` (dev:web on 4327) | No CI and no git hooks. `docs/ui/PAGE-LANE-BRIEF.md` points at `~/Projects/control-center/docs/research/...` (machine-specific) |

Timings (wall, this machine, M-series, 7-8x CPU parallelism):

| Command | Result | Wall |
|---|---|---|
| `npm run typecheck` | **fail**: 16 × TS2339 in `sample-data/generators/data/{realism-drafts,work-cast}.ts` | 21.3 s |
| `npm run lint` | **fail**: 140 errors, 3 warnings; 27 files in `sample-data/generators`, 1 warning each in `src/scanner/drive-digest/diff.ts:33` and `tests/be2b/live.smoke.test.ts:67` | 13.3 s |
| `npm run test` | **fail**: 12 files / 59 tests failed, 3,392 passed, 231 skipped | 46.5 s (collect 277 s CPU) |
| `NODE_OPTIONS=--no-experimental-webstorage npm test` | 6 files fail / 1 test: 5 DB files `spawn …/psql ENOENT` (`tests/{trace,readin,projections,ledger,bechat}/*db*.test.ts`) + THR-1 (`tests/stress/regressions.test.ts:299`, expected 1 follow-up, got 0; deterministic with FakeClock) | 45.6 s |
| `vitest run tests/engines tests/engines-org62` | 24 files pass | 3.9 s |
| `test:db`, `test:be1a`, `test:be1b`, `test:bereeval` | not run (no Postgres) | – |

Fan-out of one-file changes (`vitest related <file> --run`, files selected out of 315):

| Changed file | Test files | Wall |
|---|---|---|
| `src/components/time/badges.ts` | 9 | 8 s |
| `src/server/datasource/mock/index.ts` | 89 | 25 s |
| `src/engines/home/build.ts` | 102 | 26 s |
| `src/connectors/google/calendar.ts` | 111 | 31 s |
| `src/engines/activity/overlap-flags.ts` | 125 | 27 s |
| `src/personas/se.ts` | 161 | 34 s |
| `src/contract/common.ts` | 214 | 42 s |

Dependency matrix (runtime import edges between top-level dirs; `t` = of which type-only; tests included in the
source dir they live in; computed over `src/` + `app/` by resolving `@/` and relative specifiers):

| from \ to | contract | lib | personas | engines | db | connectors | llm | scanner | projections | outbox | jobs | server | client | ui | components |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| app | 27 (23t) | 3 | – | 2 | – | – | – | – | – | – | – | 139 | 36 | 34 | 141 |
| components | 290 (248t) | 56 | 18 | 28 | – | – | – | 2t | – | **1** | – | 24 (**tests only**) | 294 | 296 | – |
| client | 17 | 1 | 1 | – | – | – | – | – | – | – | – | 2 (tests) | – | 7 | 6 |
| ui | 1t | – | – | – | – | – | – | – | – | – | – | – | **5** | – | **1** |
| engines | 28 (23t) | 24 | 13 | – | **3 (2t)** | – | **5** | 4t | – | – | – | – | – | – | – |
| lib | 22 (18t) | – | – | **8** | – | – | – | – | **3** | – | – | **1t** | – | – | – |
| connectors | – | 2 | – | 1 | – | – | – | 11 (10t) | – | – | – | – | – | – | – |
| scanner | 1 | – | 8 | 4 | 13 | 12 | 16 | – | 2 | – | – | 2 | – | – | – |
| llm | 12 | 1 | 9 | 3 | 4 | 5 | – | 15 | – | – | – | 8 | – | – | – |
| projections | 1t | 3 | – | 8 | 6 | – | – | – | – | – | – | **10** | – | – | – |
| outbox | 16 | 5 | – | 1 | – | 2 | 6 | – | – | – | 1t | **1** | – | – | – |
| jobs | 7 | 4 | 10 | 22 | 55 | 10 | 19 | 28 | 4 | 2t | – | **72** | – | – | – |
| server | 151 | 100 | 33 | 128 | 102 | 12 | 62 | 9 | 17 | 10 | 6 | – | – | – | – |
| worker | 1 | – | – | 1 | 19 | 11 | 3 | 19 | 1 | 2 | 22 | 17 | – | – | – |

Mutual pairs (cycles at directory level): lib↔engines, lib↔projections, lib↔server, engines↔llm, engines↔scanner,
engines↔worker, llm↔scanner, connectors↔scanner, personas↔scanner, jobs↔server, llm↔server, projections↔server,
outbox↔server, scanner↔server, client↔ui, components↔ui, components↔guide, components↔app. Most are type-only edges or
one helper in the wrong folder. The ones that matter are listed in ENG-4.

## 3. Findings

**ENG-1 (blocker for every other rule): the check pipeline is red, and the reasons are not reproducible.**
- `tsconfig.json:33` and `eslint .` include `sample-data/generators/**`, which accounts for 16 type errors and 138 of
  the 140 lint errors.
- `package.json:8` says `"node": ">=20.0.0"` and README.md:10 says `brew install node`. There is no `.nvmrc`. On Node
  25, every `// @vitest-environment jsdom` test fails with `localStorage.clear is not a function` (e.g.
  `src/components/detail/__tests__/panel.test.ts:53`). With `--no-experimental-webstorage` the same 138 tests pass in
  6 s. The owner builds on a second machine (*ask #10*), so this bites on day one.
- Five root-suite DB files spawn `psql` at the Homebrew path and error instead of skipping (`tests/trace/db.test.ts:37,53`).
- THR-1 (`tests/stress/regressions.test.ts:284-301`) fails deterministically: a stalled run no longer gets its one
  delayed retry. It is a real behaviour regression or a stale test. I did not root-cause it; it belongs to the SCANNER lane.
- `npm run check` (`package.json:23`) chains four Postgres suites, so `check` cannot pass on a machine without Postgres.
  That includes the packaged-app future (*ask #12*: "no standing up a custom DB").

**ENG-2 (major): the two DataSource god files are twins, and the protocol made them so.** `db/index.ts` and
`mock/index.ts` use the same section headers in the same order (Today, Work items, NBA, Drafts, Calendar, Agents, Time,
History, Deals ~1,000 lines each, Briefs, Triage, Health, Settings, Universal, Chat, Live, Feedback, Dev). Bodies differ
mainly in `this.store` vs `m = await this.model()`. Comments mark 62 "twin/the db's/the mock's" spots. BUILD-V2.md:67
routed every lane's change through these two files. The result is merge conflicts, a 146-import header, and slow
reviews: every lane reads 4,000+ lines. *Why it matters:* every big change the other lanes propose (time-logging
redesign, assistant, data model) lands in these two files twice.

**ENG-3 (major): the mock DataSource drifts unless Postgres is present.** Drift protection exists (`tests/be1b/parity-*`),
but it is excluded from `npm test` (`vitest.config.ts:15`) and needs a local Postgres 17. Production code already
depends on mock modules: `db/index.ts:100` imports `../mock/render`, `db/index.ts:219` uses `mockSpendAudit` when the
model is seeded, `db/views.ts:39` re-exports `../mock/views`, and `src/outbox/job.ts:23` and `src/server/chat/outputs.ts:14`
import mock render. So "mock" is partly the shared core and partly a second implementation. Mock mode is also what UI
lanes, screenshots and 74 test files run on, so drift there means UI built against behaviour production does not have.

**ENG-4 (major): the layers are implicit, and a few edges point the wrong way.**
- The repository layer lives at `src/server/datasource/db/store/**`, yet `jobs` (72 imports), `projections/run.ts`
  (10), `scanner/store-db.ts`, `scanner/precheck/slack.ts` and `llm/readin/planner.ts` import it. Moving it to
  `src/db/store/` makes `server` a top layer again.
- Pure layers reaching up:
  - `src/engines/briefs/channel.ts:16` → `@/worker/schedules`
  - `src/engines/vdp/identity-judge.ts:8` → `@/db/ledger` (runtime)
  - `src/engines/nba/prompt/complete.ts:45` → `@/llm/claude-env`
  - `src/lib/landings/*` and `src/lib/canvas/preflight.ts` → `@/engines/activity/*`, `@/projections/*`, `@/server/vdp/detail` (type)
- UI edges:
  - `src/ui/chips.tsx:7` → `@/components/shell/AppLink`
  - `src/components/shell/RouteSkeleton.tsx:16-17` → `app/**`
  - `src/components/detail/DraftPanel.tsx:33` → `@/outbox/withdraw`
- `components` imports 28 pure `engines/*` helpers (e.g. `engines/home/looks-done`). That is fine (one rule shared
  client and server), as long as engines stay free of node-only imports. Today that holds by habit, not by rule.

**ENG-5 (major): the test layout follows the build history, and the hubs defeat selective runs.** About 18 of 50
folders are lane names (`p1`-`p5`, `w0`, `lanec`, `integrate1`, `contract1`, `be0`-`be2b`, `bechat`, `beoutbox`,
`bereeval`), and their contents span modules: `tests/be1b` → server 89 / db 41; `tests/stress` → scanner 77; `tests/vdp`
→ server 64 / lib 24 / engines 20. Nobody can answer "which tests cover Time?" without grep. The fan-out table shows
`--changed`/`related` saves little for core files: `src/server/datasource/index.ts:2-3` statically pulls both
DataSources (pg, drizzle, jobs, connectors) into every mock test, and `@/contract` is a 37-line `export *` barrel
imported 660 times. Collection (277 s CPU) costs 4.6× the test bodies.

**ENG-6 (minor): the DB test harness is duplicated 22 times.** Each copy uses the same `PG_BIN` constant, the same
`createdb` dance and the same migration call. Some copies `skipIf` and some throw (ENG-1). A per-file database name
scheme already exists (`CC_TEST_DB_SUFFIX` in `package.json` `test:*`). One helper would make an embedded engine
(DATA-MODEL lane) a one-file swap.

**ENG-7 (minor): the contract-first pattern pays for itself, with two gaps.** One table (`src/contract/routes.ts`) drives:
- zod validation (`src/server/http.ts:16`)
- the typed client (`src/client/api.ts`)
- live-event topics
- generated handlers
- the Assistant's read/stage/deny permissions (`src/server/chat/app-routes.ts`, D-58)
- parity tests

It is the best extensibility seam in the repo (*ask #11*). The two gaps: `gen-api-routes.ts` never removes route files
for deleted routes, and no test fails when `app/api/v1` is out of date. Almost all of the 139 `app → server` edges are
the generated `handle()` imports; only one non-API file under `app/` imports `@/server`.

**ENG-8 (minor): there is no UI smoke tier in the check.** `playwright.config.ts:7` points at a missing `e2e/`. The crawl
(`scripts/qa/crawl.mjs`) already does what a smoke suite needs, but it is manual. With the UI lane redesigning pages,
a 60-second `crawl --mock` gate costs little.

**ENG-9 (minor): the safety invariants are tested per connector, not globally.** Allowlist tests exist for Google
(`tests/be2b/google-client.test.ts:38`), VDP (`tests/vdp/client.test.ts`), skills and the scanner MCP config
(`src/llm/mcp-config.ts:61-73`). By inspection, outbound I/O (`fetch(`, `child_process`) sits only in
`src/connectors/**`, `src/outbox/**` (via the gateway), `src/tools/**`, `src/ops/**`, `src/reauth/**`, `src/scanner/**`
fetchers and `src/worker/scanning.ts`. No test pins that list, so a new connector or the "pluggable LLM provider"
(*ask #7*) could add a writer anywhere. *tenet: Nothing leaves without approval* deserves a static test.

**ENG-10 (minor): the docs are build-era.**
- `docs/ARCHITECTURE.md:3` reads "Status: proposed"; lines 12, 43, 45 and 71 say SQLite / `better-sqlite3`.
- `docs/README.md:5` says "42 decisions"; DECISIONS.md has 75, with rows up to 5,313 characters and inline amendments.
- `docs/ui/*` is 17 specs and ~710 KB. DATA-MODEL.md (5,693 lines) and SCANNER.md are still referenced as the truth by
  comments in code (`tests/be1a/store-conformance.ts:2`).
- CHANGELOG.md is 85 KB in 347 lines.
- A newcomer, or the second machine, cannot tell which doc is current. Per *ask #9*, the fix is fewer living docs, not
  more rules.

**ENG-11 (minor): the build protocol has no checked-in templates.** The chunk brief, the `files:` glob, the return
format and the reviewer pass exist only in prose (PLAN.md:180-197, BUILD-V2.md, PAGE-LANE-BRIEF.md). The lane → port
table hard-codes 4345-4356, but CLAUDE.md says 4345-4352. CLAUDE.md (45 lines) is the right density. The detail
should live in one short AGENTS.md, not in phase docs.

## 4. Recommendations (ordered)

| # | What | Effort | Depends on | Compat / migration |
|---|---|---|---|---|
| R1 | **Green, reproducible check.** Exclude `sample-data/**` from `tsconfig.json` and `eslint` (or give it its own `tsconfig` + `npm run sample:lint`, which exists). Add `.nvmrc` = `22` and `engines.node: ">=20 <25"`. `doctor` warns on 25+. README says `brew install node@22`. Make every DB-touching root test `describe.skipIf(!pgAvailable)` through one helper (R3). Triage THR-1 with the SCANNER lane | S | SCANNER (THR-1) | none |
| R2 | **Split `check`**: `check:fast` (typecheck + lint + unit/mock projects, under ~45 s now, ~20 s after R6) for pre-commit and lanes; `check` (fast + db projects + contrast + `crawl --mock`) for release, needing Postgres or the embedded engine. Optional pre-commit hook in `scripts/hooks/pre-commit`, installed by `npm run setup`, no new dependency | S | R1 | none |
| R3 | **One DB test helper**, `tests/support/pg.ts`: find `psql` on PATH, then `PG17_BIN`, then Homebrew; `freshDb(name)` and `pgAvailable`. Replace the 22 copies. Later a `CC_TEST_PG=embedded` switch (DATA-MODEL lane) | S | – | none |
| R4 | **Layer lint** (Appendix C): `@typescript-eslint/no-restricted-imports` per directory with `allowTypeImports`, so pure layers stay pure and UI never reaches the server. Start as `warn` with the current violations listed in ENG-4 grandfathered (about 12 sites), then `error` | S | – | none |
| R5 | **File-length lint**: `max-lines` warn 600 / error 1,000 (skip blank lines and comments), test files exempt, plus a grandfather list of the 11 files over 1,000 that shrinks as R7-R9 land. I recommend against 400/800: 110 files are over 400 today, so warnings would be noise | S | – | none |
| R6 | **Vitest projects by module** (Appendix D): `unit:<module>` projects (engines, lib, personas, scanner, llm, connectors, outbox, projections, jobs), `ui` (jsdom), `app` (mock DataSource integration), `db` (Postgres/embedded, its own global setup, replacing the four extra configs). `npm test -- --project engines` runs one module. Then move the lane folders into module folders (Appendix D map) with `git mv` only, one PR per module | M | R1, R3 | test paths change, so update the chunk briefs |
| R7 | **Split the DataSource by domain, interface unchanged** (strangler; details in §4.1) | L (in ~8 S steps) | R6; coordinate with every lane that edits a domain | none: `DataSource` and the routes are unchanged, and the parity suite is the oracle |
| R8 | **Promote the core**: move `server/datasource/db/store/**`, `ids`, `ext`, `enums`, `seed` → `src/db/store/**`; move `mock/render.ts` → `src/lib/compose/render.ts`; move the shared `mock/views` helpers → `src/server/views/`. Codemod imports. After R7, apply R4 at `error` | M | R7 step 1 | import paths only |
| R9 | **Decide the mock's fate** (Decision 1). In the meantime, run the parity suite in the `db` project of `check`, and add one cheap guard to `check:fast`: a contract test that every DataSource method's mock output parses against `routes[key].response` (that check exists inside `parity-reads`; lift it out so it needs no DB) | S now / L later | DATA-MODEL (embedded engine) | if the mock is retired: seed load moves to the embedded DB; `CC_DATA=mock` becomes an alias |
| R10 | **Static safety tests** (`tests/safety/`): (a) `fetch(`/`child_process`/`net` appear only in an allowlisted set of dirs; (b) every MCP tool name in `src/connectors/**` and `skills/*.md` is on a read allowlist, and write-capable names appear only in `src/outbox/adapters/**`; (c) `routes[*].assistant === 'deny'` for every send/dispatch/apply route (exists implicitly in app-routes; make it a table test). Fold in `tests/guardrails` and `tests/hygiene` | S | CONNECTORS (ask #7 registry) | none |
| R11 | **Route drift test**: `gen-api-routes.ts --check` (rebuild in memory, diff against disk, report stale files) as a unit test; the generator deletes route files it no longer owns | S | – | none |
| R12 | **UI smoke tier**: delete `playwright.config.ts` (or keep it for future e2e), add `npm run smoke` = start `dev:web` in mock on a free lane port, run `crawl --mock --max 60`, stop. It goes in `check`, not `check:fast` | S | R1 | none |
| R13 | **Golden scanner/resolution evals from `sample-data`**: a `tests/evals/` project that loads a sample-data scenario through the memory scanner store with a scripted runner (`tests/trace/fake-cli.ts` pattern), then asserts items created and auto-closed. Not part of `check:fast`. These become the regression net for ask #2 | M | SCANNER, COST lanes | none |
| R14 | **Docs reset** (§4.3, Appendix E) | S-M | – | archive moves only |
| R15 | **Agent build protocol as files** (Appendix B): `AGENTS.md` + `docs/process/chunk-brief.md` template. CLAUDE.md shrinks to invariants + commands + "read AGENTS.md" | S | – | none |

### 4.1 The DataSource split (R7), step by step

The goal is one file per domain, each 200-800 lines, with the interface and behaviour unchanged.

| Step | Change | Verify |
|---|---|---|
| 1 | Introduce `DbCtx` (`model()`, `mutate()`, `bus`, `now()`, `userId()`, `handle`) and `MockCtx` (store, bus, clock), and pass them to domain modules. `DbDataSource` keeps every method as a one-line delegate | typecheck; parity suites; `tests/integrate1`, `tests/contract1` |
| 2 | Move one low-risk domain per PR, read-heavy ones first: Calendar → Briefs/Watches → History → Health/Spend → Settings/Policy → Triage → Deals/VDP → Time → Work items/NBA/Drafts → Chat. Files: `db/domains/<domain>.ts`, `mock/domains/<domain>.ts` | the same, plus the domain's module project |
| 3 | For each moved domain, pull the twin *read* bodies into `src/server/views/<domain>.ts`, which takes a `ReadSource` interface (`all`, `get`, `settings`, `meta`, `spend`); both `ReadModel` and the mock `Store` already satisfy it. Mock and db then each keep only their writes | parity-reads: every read must stay equal |
| 4 | `DataSource` interface: split `types.ts` into per-domain interfaces (`DealsSource`, `TimeSource`, …) intersected into `DataSource`. Lanes then own a domain file, not a shared index | typecheck |
| 5 | `datasource/index.ts`: move the db import behind `createDbDataSource` in a separate `db-entry.ts`, so tests that only use mock stop collecting pg/drizzle/jobs (ENG-5). Measure with `vitest related` | the fan-out table should drop (target: a leaf engine file → under 40 files) |

Expected outcome: `db/index.ts` becomes about 400 lines of wiring, mock about 300, plus ~20 domain files. An estimated 2,000-3,000
duplicate read lines are deleted (estimate, not measured). The order lets other lanes' redesigns (Home, Time, Assistant) land into a domain file
instead of the hub. Each step is mechanical and parity-guarded, so a Sonnet builder can do it under a narrow `files:` glob.

### 4.2 Other refactors, in order, and what not to touch

| Order | Refactor | Scope / risk | Verify | Ordering constraint |
|---|---|---|---|---|
| a | `scanner/store-db.ts` (2,540) → `store-db/{ledger,items,coverage,spend,findings,health}.ts` behind `DbScannerStore` | M / low: `runScannerStoreConformance` covers both stores | `tests/be1a` conformance, `tests/stress`, `tests/trace` | after R3 (it needs PG); before SCANNER-lane changes, or *by* the SCANNER lane as its first chunk |
| b | `projections/run.ts` (1,624) → `projections/passes/{accounts,week,onsite,readback}.ts`; it should stop importing `server/datasource/db/store` (R8) | M / medium (time engine) | `tests/projections`, `tests/time`, `time:rederive --dry` on sample-data | after R8; coordinate with the TIME lane (ask #6) |
| c | `engines/home/build.ts` (1,500, pure) → one file per Home section + `ctx.ts` | S / low | `tests/home`, `tests/guardrails/pending-never-done` | **only after** the UI lane fixes the Home structure (ask #1), otherwise it gets split twice |
| d | Connector registry: one `ConnectorDef` per source (id, read-tool allowlist, fetcher, scanner spec, health probe, reauth hint, setup copy), instead of the spread `CONNECTOR_META` (`store-db.ts:109`), `RESCAN_SCOPE` (`db/index.ts:241`), `scanner/runtime/connectors`, onboarding sources | M / medium | R10 allowlist tests, `tests/be2b`, `tests/onboarding` | owned by the CONNECTORS lane (ask #7); R10 first |
| e | LLM provider seam: `src/llm/*` already funnels through `one-call`, `skill-runner`, `claude-env`; make an interface `ModelProvider` (complete, run-with-tools, cost) with a Claude implementation only, and fix `engines/nba/prompt/complete.ts:45` to go through it | S-M / low | `tests/llm`, `tests/be2a`, ledger-gaps setup | owned by the COST/LLM lane; do not build an OpenAI adapter until someone needs it |
| f | Skills as prompt modules: `skills/*.md` (40) are already versioned by content hash (`scanner/store-db.ts:211`) and tested (`tests/skills`, `tests/be2b`). Add front-matter (`id`, `tier`, `tools`) and a test that the declared tools ⊆ the allowlist. Don't convert them to TS | S / low | `tests/skills/evalset` | with the COST lane's model-tier work (ask #3) |
| g | Lists: consolidate only where the UI lane's design calls for one list primitive (`@/ui` `ListContainer`/`ListRow` already exist) | – | – | UI lane decides |

**Do not refactor:**
- the route table, generator and `handle()` (ENG-7)
- `src/db/changeset.ts`, audit and undo
- `tests/setup/ledger-gaps.ts`
- the Outbox gateway and adapters' approval flow
- personas (`src/personas`, 558 lines, small and clear)
- `@/ui` primitives
- the `client` data layer (`api`/`useApi`/live topics)
- `src/db/schema/**` (DATA-MODEL lane owns schema change)
- `scanner/runtime/scanner-runtime.ts`, until the SCANNER lane has a verdict

Do not introduce a monorepo, turborepo, Nx, packages or DI containers. At 226k lines in one app, directory boundaries
plus lint give 90 % of the value.

### 4.3 Testing strategy (the concise version, for ask #10)

1. **Tiers.**
   - **Unit:** pure functions and engines with fakes, co-located `src/<module>/**/x.test.ts`; target under 10 s per
     module.
   - **App:** the mock DataSource through `handle()`; `tests/app/<domain>/`; one fresh store per file.
   - **UI:** jsdom component tests co-located under `src/components/**`.
   - **DB:** Postgres, or later the embedded engine; `tests/db/<domain>/`; one shared helper; includes parity and
     conformance.
   - **Smoke:** `crawl --mock`.
   - **Evals:** sample-data scenarios plus skill goldens; on demand and before a release.
2. **Run what you touched.** Use `npm test -- --project <module>` while building. `check:fast` before a commit. `check`
   before a release or a merge to main. Vitest `--changed origin/main` is useful *after* R7 step 5 cuts the hubs; until
   then it selects 30-70 % of the suite for core files (measured above), so it is not worth wiring into scripts yet. A
   turborepo-style task graph is overkill: one package, and `tsc` already runs in 21 s.
3. **One behaviour, two stores → one suite.** Every store with two implementations (DataSource, ScannerStore) is tested
   by a shared conformance suite run against both (`runScannerStoreConformance` is the model). New DataSource methods
   add a parity case in the same PR.
4. **Fakes, not network.** `FakeClock`, scripted SDK (`tests/readin/fake-sdk.ts`), `tests/trace/fake-cli.ts`. Tests never
   import a live client (invariant 1).
5. **Name tests after behaviour and module, never after the lane** that wrote them.

### 4.4 Docs (ask #9, ENG-10)

| Tier | Files | Rule |
|---|---|---|
| Living (edited with the code) | `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/TENETS.md`, `docs/ARCHITECTURE.md` (rewritten as built: Postgres, processes, layer table, connector matrix; ≤ 300 lines), `docs/DATA-MODEL.md` (moved out of ui/, trimmed by the DATA-MODEL lane), `docs/UX.md`, `docs/BACKLOG.md`, `docs/RELEASING.md`, `CHANGELOG.md` | a PR that changes behaviour updates the doc in the same PR |
| Decisions | `docs/decisions/NNNN-slug.md` (ADR-lite: Context, Decision, Consequences, Supersedes; ≤ 30 lines) + `docs/DECISIONS.md` as a one-line-per-decision index (ID, title, status, date, link) | an amendment is a new ADR that supersedes the old one, never an edit inside a table cell. D-1..D-75 get converted lazily: the index row now, the ADR file when one is next touched |
| Reference (stable specs) | `docs/reference/{SCANNER,WORKER,OPS,CONTRACT}.md` | trimmed to the current design; mark sections that are not built |
| Archive | `docs/archive/2026-build/` ← `docs/ui/{BUILD-PLAN,BUILD-V2,CHECKPOINTS,PAGE-LANE-BRIEF,STRESS,FIRST-SCAN-RAMP,time-redesign,DESIGN-V2,UI-SPEC,REQUIREMENTS}.md`, `docs/PLAN.md` (phases), `docs/EDGE-CASES.md` if not maintained | read-only; code comments that cite them get rewritten when touched |

DECISIONS vs CHANGELOG: CHANGELOG records *what shipped* (user-visible, per release, ≤ 3 lines per item). An ADR
records *why we chose X over Y*, for choices that constrain future code. A UI tweak gets no ADR.

## 5. Decisions for Tristan

1. **The mock DataSource's future.**
   - (a) Keep it and run parity in `check` (needs Postgres).
   - (b) Keep it and generate nothing, but share read views (R7 step 3), so only the write paths are twins.
   - (c) Retire it: mock mode becomes the db DataSource over an embedded Postgres seeded from `seed.example.json`
     (PGlite or similar, per the DATA-MODEL lane), with the scenario clock and dev routes ported.

   **Recommendation: (b) now, (c) once the DATA-MODEL lane confirms an embedded engine runs our migrations.** The
   packaged app needs an embedded DB anyway (ask #12), so (c) removes most of the 7,681 lines in `src/server/datasource/mock/` (some, such as render and views, move to shared code) and a whole class of drift. Risk:
   mock-only features (scenario autoplay, `devFail`, demo read-ins) need a db-side equivalent, and LISTEN/NOTIFY
   behaviour in an embedded engine is unverified by me.
2. **Test location.** Co-locate unit tests next to the module (recommended; 59 already are), or keep everything under
   `tests/<module>`. Either works with vitest projects. Co-location makes `files:` globs simpler, since a lane's glob
   already covers its tests.
3. **Build protocol weight.** Keep orchestrator + worktree lanes + `files:` globs (recommended). Drop the "one-line
   additive edits to shared index files" rule once R7 lands, since lanes then own domain files. Add one rule: a lane
   that touches more than two modules splits into chunks.
4. **Lint strictness.** `max-lines` 600/1,000 and boundaries as warn-then-error with a grandfather list (recommended),
   or error from day one (forces ~11 splits before any feature work; it slows building, which ask #9 rules out).

No recommendation here conflicts with a tenet. R10 strengthens *tenet: Nothing leaves without approval*.

## 6. What's fine, don't touch

- **Contract-first routes**: one table drives validation, client types, generated handlers, live topics and
  Assistant permissions (ENG-7).
- **Conformance and parity suites** (`tests/be1a/store-conformance.ts`, `tests/be1b/parity-*`). They are the oracle that
  makes R7 safe.
- **`tests/setup/ledger-gaps.ts`**: a 13-line global invariant that catches unaudited model spend in every test.
- **`tests/guardrails/unread-fields.test.ts`**: a cheap, high-value "computed but never drawn" check.
- **UI never imports server code at runtime**: all 24 `components → server` edges are tests.
- **Strict TS, `@/` alias, zod at the edge, `FakeClock` / scripted SDK fakes**, the `CC_MOCK_NOW`/`CC_SEED_REBASE` test
  determinism (`vitest.config.ts:17-24`).
- **CLAUDE.md density** (45 lines). Keep it that short.
- **Typecheck 21 s, lint 13 s**: fast enough. No incremental-build tooling is needed.

## 7. Open questions / not verified

- None of the Postgres suites ran (`test:db`, `be1a`, `be1b`, `bereeval`, and ~18 `*-db` files), so I do not know
  whether they pass on HEAD.
- THR-1's root cause: is the test stale, or did the scanner regress?
- I did not test whether `--no-experimental-webstorage` or a vitest upgrade is the better Node-25 fix. Pinning 22 LTS
  is the low-risk path.
- `@typescript-eslint/no-restricted-imports` with `allowTypeImports` under the FlatCompat next config: I expect it to
  work but did not run it. `eslint-plugin-import` 2.32 (installed) offers `import/no-restricted-paths` as a fallback,
  without type-import exemptions.
- Whether an embedded Postgres handles the drizzle migrations, LISTEN bus and `pg` pool: DATA-MODEL lane.
- Git history is scrubbed (3 commits), so churn-based hot-spot analysis was not possible.

---

## Appendix A — `CONTRIBUTING.md` (draft, drop in at repo root)

```markdown
# Contributing to Control Center

Local app, one Next.js process + one worker, Postgres. Read `docs/TENETS.md` first; a change that bends a tenet stops
and asks. Safety invariants are in `CLAUDE.md` and are tested in `tests/safety/`.

## Setup
`nvm use` (Node 22) · `npm install` · `npm run dev` (mock data by default) · `npm run doctor`.

## Where code goes (layers: a layer may import only from layers above it in this list)
| Layer | Dirs | May import |
|---|---|---|
| 0 Shared | `contract`, `lib` | each other (contract ← lib only for types) |
| 1 Domain (pure) | `personas`, `engines` | layer 0. No node-only modules, no db, llm, worker |
| 2 Infra | `db` (schema, store, changeset), `connectors`, `llm`, `scanner`, `projections`, `outbox`, `tools` | 0, 1, `db` |
| 3 App | `jobs`, `server`, `worker`, `ops`, `reauth` | 0-2 |
| UI | `ui` (primitives) → `client` → `components`, `guide` → `app/` | 0, 1, and type-only imports of anything |
`app/api/**` is generated (`npm run gen:routes`); don't edit it. Lint enforces this table.

## Rules of thumb
- **Contract first.** A new endpoint = a row in `src/contract/routes.ts` + schemas + a DataSource method in its domain
  file (`src/server/datasource/{db,mock}/domains/<domain>.ts`) + a parity case. Then `npm run gen:routes`.
- **No business logic in `.tsx`.** Derivations live in a sibling `.ts` (tested) or in `engines/`.
- **Files stay small.** Lint warns at 600 lines and fails at 1,000. Split by domain, not by "utils".
- **Schema changes** follow `docs/DATA-MODEL.md` § Migrations: additive first, backfill, then remove; never edit a
  shipped migration.
- **Outbound anything** (send, post, write) goes only through `src/outbox/adapters/**` as an Outbox action the user
  approves. Connectors use read tools only.
- **No new dependency** without saying why in the PR.

## Tests
`npm test -- --project <module>` while you work · `npm run check:fast` before commit · `npm run check` before release
(needs Postgres). Unit tests sit next to the code; DB tests in `tests/db/<domain>/`. Two implementations of one
interface share one conformance suite. Name tests after behaviour, not after who built them.

## Docs to update in the same PR
User-visible change → `CHANGELOG.md` (Unreleased). A choice that constrains future code → a new
`docs/decisions/NNNN-*.md` (≤ 30 lines; supersede, never amend in place). Architecture change → `docs/ARCHITECTURE.md`.
Release: `docs/RELEASING.md`.
```

## Appendix B — `AGENTS.md` (draft; CLAUDE.md keeps invariants + commands and links here)

```markdown
# Agent build protocol

## Roles
Orchestrator (one session, owns the plan and merges) · Builder (one chunk, one worktree) · Reviewer (fresh session,
reads the diff, not the narrative) · Validator (drives the real UI; outbound stops at draft/dry run).

## A chunk brief (copy docs/process/chunk-brief.md)
id · goal (one sentence, user-visible) · `files:` glob (the builder's write scope; tests included) · read-first
(≤ 5 files) · acceptance (observable result + the test that proves it) · port (4345-4352 if it runs the UI) · model
(sonnet default, opus for `hard`).

## Builder rules
1. Stay in `files:`. Need something outside? Return `blocked` with the exact change you need; don't make it.
2. Run `npm test -- --project <module>` while building and `npm run check:fast` before returning.
3. "Validated" = the real path ran to terminal success and the user-visible result is there (screenshot via
   `npm run shot -- <route> --port <lane port>` for UI). Exit 0 alone is not validation.
4. Never send, post or write to an external system; never widen a read allowlist; never print secrets.
5. A tenet conflict is a blocker, not a workaround.

## Return
{chunk, status: built|failed|blocked, sha, files, verify: "<cmd + result>", blockers: []}

## Review (per wave, on the diff)
Tenets and invariants first, then layer/length lint, then tests that would catch a regression. Hard violations get
fixed now; the rest become BACKLOG rows.

## Parallel lanes
Lanes own modules or domain files, not shared hubs. If two chunks need the same file, sequence them. Shared seams
(`src/contract/routes.ts`, the DataSource interface) are changed by the orchestrator or one designated chunk per wave.
```

## Appendix C — lint additions (sketch for `eslint.config.mjs`; verify before relying on it)

```js
const banned = (groups) => ({ '@typescript-eslint/no-restricted-imports': ['error', { patterns: groups.map((g) => ({
  group: [`@/${g}/*`, `@/${g}`, `**/src/${g}/*`], allowTypeImports: true, message: `layer rule: see CONTRIBUTING.md` })) }] });
export const layerRules = [
  { files: ['src/contract/**', 'src/lib/**'], rules: banned(['engines', 'projections', 'server', 'db', 'jobs', 'worker', 'llm', 'scanner', 'components']) },
  { files: ['src/engines/**', 'src/personas/**'], rules: banned(['db', 'llm', 'worker', 'jobs', 'server', 'components', 'client']) },
  { files: ['src/ui/**'], rules: banned(['components', 'server', 'db', 'jobs', 'worker']) },
  { files: ['src/components/**', 'src/client/**', 'src/guide/**'], ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: banned(['server', 'db', 'jobs', 'worker', 'llm', 'connectors', 'scanner', 'outbox', 'projections']) },
  { files: ['src/**', 'app/**'], ignores: ['**/*.test.*', 'tests/**', 'scripts/**', ...GRANDFATHERED_LONG],
    rules: { 'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }] } },
  { files: ['src/**', 'app/**'], ignores: ['**/*.test.*', ...GRANDFATHERED_LONG],
    rules: { 'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }] } },
];
// GRANDFATHERED_LONG: the 11 files > 1,000 lines today (db/index, mock/index, scanner/store-db, projections/run,
// engines/home/build, scanner-runtime, store-memory, projections/activity, engines/activity/use-cases, contract/vdp,
// db/store/work). Remove an entry when the file is split; a test fails if an entry is under 1,000 lines (stale).
// Add `sample-data/**` to ignores (ENG-1).
```

Starting with `warn` for the `banned` rule and a per-file `// eslint-disable-next-line` on the ~12 sites in ENG-4 is
the cheapest way in.

## Appendix D — vitest projects and test map

```ts
// vitest.config.ts (vitest 3.2.7 supports test.projects)
const mod = (name: string, extra = {}) => ({ extends: true, test: { name, include: [`src/${name}/**/*.test.ts`, `tests/unit/${name}/**/*.test.ts`], ...extra } });
export default defineConfig({ resolve, test: { setupFiles: ['tests/setup/ledger-gaps.ts'], env, projects: [
  ...['engines', 'lib', 'personas', 'scanner', 'llm', 'connectors', 'outbox', 'projections', 'jobs', 'tools', 'ops'].map((m) => mod(m)),
  { extends: true, test: { name: 'ui', environment: 'jsdom', include: ['src/{components,client,ui,guide}/**/*.test.{ts,tsx}'] } },
  { extends: true, test: { name: 'app', include: ['tests/app/**/*.test.ts'] } },          // mock DataSource via handle()
  { extends: true, test: { name: 'db', include: ['tests/db/**/*.test.ts'], globalSetup: ['tests/support/pg-global.ts'] } },
  { extends: true, test: { name: 'safety', include: ['tests/safety/**/*.test.ts'] } },
] } });
// package.json: "test": "vitest run --project '!db'", "test:db": "vitest run --project db",
//   "check:fast": "npm run typecheck && npm run lint && npm test", "check": "npm run check:fast && npm run contrast && npm run test:db && npm run smoke"
```

Folder moves (by dominant import, `git mv`, one PR per row):

| Today | Target |
|---|---|
| `be0`, `ledger`, `setup` | `tests/db/core` (changeset, queue, migrations, ledger) + `tests/setup` |
| `be1a`, `be2a`, `be2b`, `stress`, `trace`, `completion` | unit → `tests/unit/scanner`, `tests/unit/connectors`; PG → `tests/db/scanner` |
| `be1b`, `integrate1`, `contract1`, `w0` | `tests/db/parity` (PG), `tests/app/contract` (mock) |
| `bechat`, `readin`, `llm` | `tests/app/chat`, `tests/unit/llm`, `tests/db/chat` |
| `beoutbox`, `compose` | `tests/unit/outbox`, `tests/unit/lib` |
| `bereeval`, `settle`, `engines`, `engines-org62`, `skills` | `tests/unit/engines/**`; `skills` → `tests/evals/skills` |
| `p1`-`p5`, `lanec`, `live`, `home`, `history`, `handoff` | `src/components/<page>/__tests__` (jsdom) or `tests/app/<page>` |
| `time`, `deals`, `vdp`, `landings`, `forecast`, `projections`, `briefs`, `calendar`, `events`, `feedback`, `onboarding`, `personas`, `tools`, `ops`, `hygiene` | `tests/app/<domain>` (mock), `tests/db/<domain>` (`*-db.test.ts`), `tests/unit/<module>` (pure) |
| `guardrails`, `hygiene/job-kinds`, `be2b/skills-and-fixtures` (placeholder checks) | `tests/safety` |

## Appendix E — `docs/README.md` (draft)

```markdown
# Docs

| Read | When |
|---|---|
| ../README.md | Install, run, personas, update, where state lives |
| ../CONTRIBUTING.md | Where code goes, rules, tests, which docs to update |
| ../AGENTS.md | Building with Claude sessions: chunk briefs, lanes, return format |
| TENETS.md | North stars; cite by name; conflicts are blockers |
| ARCHITECTURE.md | Processes, layers, connectors, data flow, Outbox (as built) |
| DATA-MODEL.md | Tables, ownership, migration rules |
| UX.md | Views and interaction principles |
| DECISIONS.md | Index of decisions → decisions/NNNN-*.md |
| BACKLOG.md | Ideas and their phase |
| RELEASING.md | Versioning, release, update path |
| reference/ | Scanner, worker, ops, contract specs (current design) |
| archive/ | Build-era plans and specs (2026). Historical; not maintained |
| reviews/ | Audits and reviews, dated |
```
