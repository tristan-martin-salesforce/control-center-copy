# Contributing to Command Center

A local app: one Next.js web process, one Node worker, Postgres. Read [`docs/TENETS.md`](docs/TENETS.md) first; a
change that bends a tenet stops and asks Tristan. The hard invariants are in [`CLAUDE.md`](CLAUDE.md). Building with
Claude sessions? Also read [`AGENTS.md`](AGENTS.md). Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Setup:** `nvm use` (Node 22) · `npm ci` · `npm run dev` (mock data by default) · `npm run doctor`.

## Where code goes
A layer may import only from layers above it. Type-only imports are always allowed; tests are exempt. Lint
(`eslint.config.mjs`) is an error on the rows marked ✓ (nothing is grandfathered since 2.0).

| Layer | Dirs (`src/…`) | Must not import | Lint |
|---|---|---|---|
| Shared | `contract`, `lib` | `server`, `db`, `components`, `worker`, `llm` | ✓ |
| Domain (pure) | `personas`, `engines`, `projections` | `server`, `db`, `components`, `worker`, `llm`. No node-only modules | ✓ |
| Infra | `db`, `connectors`, `llm`, `scanner`, `outbox`, `tools` | `connectors` never imports `engines` or `server` | ✓ (connectors) |
| App | `jobs`, `server`, `worker`, `ops`, `reauth` | UI dirs | |
| UI | `ui` → `client` → `components`, `guide` → `app/` | `server`, `db` | ✓ |

`app/api/v1/**` is generated (`npm run gen:routes`); never edit it. A grandfather list in `eslint.config.mjs` only
shrinks: fix a site, remove its path; never add one. A pure layer that needs the database or a model file takes a port its caller builds and passes in (`ProjectionStore` via `projectionStore(db)`, `ResolutionStore`, `LadderOptions.skill`, `Complete` via `agentSdkComplete` from `src/llm/complete-sdk.ts`); it never imports the implementation.
Entry points (CLIs, workers) live in `scripts/` or `src/worker`, never inside an engine: they are the composition roots that build the ports.

## Rules
- **Contract first.** A new endpoint is a row in `src/contract/routes.ts` plus its zod schemas, a DataSource method
  (db and mock, in its domain: "Where a DataSource method goes" below) and a parity case; then `npm run gen:routes`. The route's Assistant class (read, stage, deny) is part
  of the row; anything that sends or applies is `deny`.
- **No business logic in components.** A `.tsx` file renders. Derivations live in a sibling `.ts` (tested) or in
  `src/engines/`.
- **Barrels stay thin.** An engine's `index.ts` only re-exports (no code of its own), and it is for callers outside the
  engines; inside `src/engines`, the DataSources (`src/server/datasource/{mock,db}`) and `src/server/views`, import the
  leaf by path (`@/engines/activity/time`, not `@/engines/activity`). A barrel import pulls every module of the engine
  into every test that reaches you. `tests/hygiene/engine-fanout.test.ts` enforces it and pins how many test files a
  leaf engine reaches ([21-engine-fanout](docs/reviews/2026-11-20-holistic/21-engine-fanout.md)).
- **Files stay small.** `max-lines` warns at 600 and errors at 1,000 (blank lines and comments not counted; tests
  exempt). Split by domain, not into `utils`: into `<name>.<part>.ts(x)` siblings, with the original path kept as the
  entry that re-exports the public names (parts never import the entry); a long class splits into abstract layers
  (`<Name>Base` ← … ← `<Name>`, private → protected). Parts may import each other as a chain, each one way
  (`store-db.base ← items ← proposals ← finish`), never as a cycle. None is grandfathered over 1,000 any more.
- **Migrations** ([D-96](docs/decisions/0096-migration-discipline.md)): additive first; a backfill is a job (or an
  idempotent statement), never a destructive step in the migration; contract fields dual-write for one release; no
  destructive change inside a minor (a major gets a dump first and a verified restore); never edit a shipped
  migration. The worker refuses to claim jobs when its bundled migrations and the database disagree.
- **Outbound anything** (send, post, write) goes only through `src/outbox/adapters/**` as an Outbox action the user
  approves. Connectors call read tools only, on an allowlist nobody widens.
- **Logs** carry ids, statuses, timings and error codes; never message bodies, tokens or cookies.
- **New UI** uses the component kit and Tailwind with the tokens; no new CSS modules ([`docs/UX.md`](docs/UX.md)).
- **The product name** is Command Center (D-101). The state folder name lives in one constant per language (`src/ops/paths.ts`, `scripts/ops/lib/paths.mjs`; `src/db/client.ts` repeats it because infra cannot import `src/ops`); never write the path as a literal. The old 1.x names appear only in `scripts/ops/lib/migrate-state*.mjs` (`tests/ops/rename-grep.test.ts` enforces it). `CC_*` variables, `cc` prefixes and the `control_center_*` test database prefixes keep their names.
- **No new dependency** without saying why.

## Where a DataSource method goes
A route's method lives in its domain (the map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) "The DataSource"):
1. **Interface:** the method in `src/server/datasource/types/<domain>.ts` (same name as the route key).
2. **Implementations:** the body in `db/domains/<domain>.ts` and `mock/domains/<domain>.ts`; the facades
   (`db/index.ts`, `mock/index.ts`) get only a one-line delegate. Shared needs come from the context (`this.ctx`:
   `model(scope)`, `mutate()`, `tx()`, `bus`, `now()`, …); another domain is `this.ctx.ds.<domain>`.
3. **Reads** go once in `src/server/views/<domain>.ts` over `ReadSource`; the twins pass their store (the db's read
   model, the mock's `Store`) and whatever only they know as a typed argument (`TodayReads`, `TimeWeekReads`). SQL
   that narrows a list comes in the same way, as candidate ids (`WorkReads`): a superset the view filters again, so
   the view alone defines the answer. A read that would behave differently per store is decided first (the db wins
   where the spec is silent), never forked in the body (`docs/reviews/2026-11-20-holistic/19-read-twins.md`).
4. **Parity:** a case in `tests/db/datasource/parity-reads.test.ts` or `parity-mutations.test.ts`.
5. **New domain:** all three files (db, mock, types) and its row in `tests/datasource/layout.test.ts`.

## Safety invariants, tested
`tests/safety/` pins them statically, so a refactor cannot quietly break one:
- `network-surface.test.ts`: `fetch(`, `child_process` and network clients appear only in allowlisted places, each
  with its reason. Adding one is a review decision.
- `mcp-tools.test.ts`: every MCP tool a connector or skill names is on the read allowlist; write-capable tool names
  appear only in the Outbox, the VDP write client and the deny lists; an unclassified tool name fails.
- `route-classification.test.ts`: every send, dispatch or apply route is `deny` for the Assistant.
- `unread-fields.test.ts`, `pending-never-done.test.ts`: every derived field has a reader; pending never reads as done.
- `tests/setup/ledger-gaps.ts` (global): every booked model call has its audit fields.

## Tests
Unit tests sit next to the code (`src/<module>/**/x.test.ts`) or in `tests/<module>/` (the folder is named after the
`src/` module it covers), never after the chunk or lane that wrote them. Name tests after the behaviour. Two
implementations of one interface share one conformance suite. Tests use fakes (`FakeClock`, the scripted SDK,
`tests/trace/fake-cli.ts`), never a live client.

**Projects** (`vitest.config.ts`; the file's header is the reference). Every test belongs to exactly one:

| Project | What it holds | Run |
|---|---|---|
| `unit` | everything pure or on the mock DataSource: `tests/**` and `src/**` `*.test.ts` that are not below. No Postgres, parallel | `npm run test:unit` |
| `ui` | the jsdom (DOM) tests (`*.dom.test.ts`, or a `@vitest-environment jsdom` docblock), `tests/ui/**`, the contrast gate, the internal-ids lint | `npm run test:ui` |
| `db` | `tests/db/<module>/**`: files that make their own database with `tests/support/pg.ts` (`freshDb`) | `npm run test:db` |
| `db-core`, `db-worker`, `db-datasource`, `db-reeval`, `db-retention` | the suites with their own global setup that drops, creates and migrates one database (`tests/db/core`, `worker`, `datasource`, `reeval`, `retention`) | `npm run test:db:<suite>` |
| `evals` | `tests/evals/**/*.eval.ts`: scanner recall and closure precision on the golden cases, offline | `npm run test:evals` |
| `smoke` | `tests/smoke/**`: the crawl, `npm run smoke:crawl -- --mock [--port N] [--persona se|ae] [--scale N]` (`--scale N`: the seed ×N at load, `CC_SEED_SCALE`, `src/mock/scale.ts`; every route, Settings section and Activity view, as the seed's SE or, with `--persona ae`, as a Specialist AE over the AE seed overlay `src/mock/persona-seed.ts`; fails on a console error, error boundary, 5xx or missing `<h1>`; skipped when no browser) | `npm run smoke:crawl` |

Accessibility: `npm run test:a11y` (`tests/a11y/axe-pages.ts`, a script, not a vitest project) runs axe-core on every page, both themes, against a production mock build on :4434 (`npm run build`, then `PORT=4434 CC_DATA=mock npm run start`); it fails on a violation `tests/a11y/baseline.json` does not list, and `-- --update` shrinks the baseline after a fix.

`npm test` = `unit` + `ui` (seconds to a couple of minutes, no setup). `npm run test:db` = every `db*` project, serial
(`--maxWorkers=1`, and `fileParallelism` off whenever a `db*` project is selected), and needs Postgres 17.
`npm run check:fast` = typecheck + lint + `npm test`: the loop for lanes and pre-commit. `npm run check` =
`check:fast` + `test:db` + `test:evals`: before a release. The old per-suite scripts (`test:be0`, `test:be1a`,
`test:be1b`, `test:bereeval`, `test:bechat`, `test:beoutbox`) still work as aliases into the db projects.

**Where a test goes.** Does it need Postgres? Then `tests/db/<module>/` (name the file `*-db.test.ts` or `db.test.ts`),
using `freshDb` from `tests/support/pg.ts` (`describe.skipIf(!pgAvailable)`). Is it a DOM test? Put the
`@vitest-environment jsdom` docblock first and it lands in `ui` by itself. Anything else is `unit`. A test never needs
Postgres to be in `unit`: that is what keeps `npm test` fast and honest.

**Database tests.** Set `CC_TEST_DB_SUFFIX=<your chunk id>` so parallel builders never share a database. The suite
database names stay `control_center_<be0|be1a|be1b|bereeval|retention>_<suffix>` (`tests/support/db-urls.ts`) even though the
folders are module-named, so databases other checkouts already made keep working.

**Flake policy.** No per-test or per-hook timeout bump that exists only because the machine was loaded: the `db`
projects run serially and carry their own `testTimeout` / `hookTimeout`; a slow test is a finding, not a number to
raise. A timeout longer than the project's is allowed only with a comment saying why the work is legitimately long
(`db-reeval` runs a whole job per test; `smoke` compiles every route). `vi.setConfig({ testTimeout })` is not used.

**No real timers or wall clock in `unit` and `ui` tests.** `npm test` runs on a loaded machine (the app, a browser, a few agents), so a test never sleeps and then asserts, never races the code's own `setTimeout`, and never reads `Date.now()` against a deadline. Delays and debounces: `vi.useFakeTimers()` (narrow it with `toFake: ['setTimeout', 'clearTimeout']` when the code also awaits real I/O) and `vi.advanceTimersByTimeAsync(ms)`, stepping to just before and just after the delay; in a DOM test, `advance(ms)` from `src/components/composer/__tests__/dom.ts` does it inside `act`. Clocks: pass the clock the code already takes (`FakeClock`, `now: () => NOW`, `delays`); freeze `Date` with `vi.useFakeTimers({ toFake: ['Date'] })` only where it does not. Work that settles on its own (a mock read-back, a refetch): wait for the condition, not a time, with `waitFor` (DOM) or `until` / `eventually` (`tests/support/until.ts`), whose budgets are counted in polls, never in wall-clock ms (`vi.waitFor` is not used: its 1 s cap is wall clock). A module a check loads lazily is imported by the test file, so its transform is not paid inside a test's timeout. A real child process is allowed only where the process is the thing under test, with a comment.

**Route drift.** `tests/contract/route-drift.test.ts` fails when `src/contract/routes.ts` and the generated
`app/api/v1/**/route.ts` differ (run `npm run gen:routes`), or when a route has no test naming it and is not in its
`UNTESTED` list with a reason.

DB suites need Postgres 17 (`export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH`). Before a commit:
`npm run check:fast`. Before a release: `npm run check`.

## Docs change with the code
- Behaviour change: the living doc that describes it (`README.md`, `docs/UX.md`, `docs/ARCHITECTURE.md`,
  `docs/EDGE-CASES.md`) in the same commit.
- **`CHANGELOG.md`** (Unreleased) records *what shipped*, user-visible, at most three lines per item.
- **An ADR** (`docs/decisions/NNNN-slug.md`, at most 30 lines: Context, Decision, Consequences, Supersedes, plus a
  row in `docs/DECISIONS.md`) records *why*, for a choice that constrains future code. An amendment is a new ADR
  that supersedes the old one; never edit one in place. A UI tweak gets no ADR.
- Releasing: [`docs/RELEASING.md`](docs/RELEASING.md).
- **Engine changes.** A change to what an engine decides (a rule, weight, threshold, prompt or model choice under `src/engines/**`, `src/projections/**`, `src/llm/**`, `src/scanner/**` or `src/jobs/handlers/**`) follows [`docs/ENGINES.md`](docs/ENGINES.md): state it as a general rule, keep the facts as data, add a fixture case, bump the rule version, and add one line to [`docs/engines/CHANGELOG.md`](docs/engines/CHANGELOG.md) with the date, the reason, the decision or review that asked for it, and the test that pins it. A Settings edit, a seed change or a learned rule is not an engine change.
