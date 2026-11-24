# 21 · Engine fan-out (ENG-5, R7 step 5 follow-up)

Chunk `post-engines-barrel-fanout`, 2026-11-21. The question: why `vitest related <leaf engine file>` still selects
~130 test files after the DataSource split (CHUNKS `p1-datasource-split`: "the mock barrel keeps leaf engines at 131
related tests"), and what fixes it.

## 1. How it was measured
- **`related`**: vitest's own selection (`createVitest` → `specifications.getTestDependencies`, the code
  `vitest related` runs), unit + ui projects, 429 test files. No test runs.
- **`outside mock`**: the same graph with `src/server/datasource/mock/index.ts` removed: test files that reach the leaf
  without building the whole mock DataSource. This is the part barrels and import paths control.
- `tests/hygiene/engine-fanout.test.ts` repeats the walk statically (TypeScript transpile, so type-only imports are
  erased the way vitest's transform erases them; dynamic `import()` counted). Its counts match vitest's exactly.

## 2. Before and after

| Leaf | related before | related after | outside mock before | outside mock after |
|---|---:|---:|---:|---:|
| `src/engines/activity/overlap-flags.ts` | 137 | 128 | 62 | 50 |
| `src/engines/priority/hash.ts` (`score.ts` the same) | 133 | 129 | 51 | 45 |
| `src/engines/resolution/escalation.ts` (`ladder.ts`: 4) | 11 | 11 | 11 | 11 |
| `src/engines/needs/providers/triage.ts` (`dc.ts` the same) | 110 | 110 | 12 | 10 |
| `src/db/queue.ts` | 132 | 132 | 36 | 36 |
| `src/engines/use-cases/extract.ts` (extra) | 109 | 109 | 10 | 10 |

The < 40 target is met for `resolution` and `needs` leaves outside the mock and for `resolution` overall. It is
**not** met overall for any leaf the mock DataSource uses, and barrels were not the reason.

## 3. The paths
1. **The mock DataSource is the hub (≈100 of the ~130).** 102 test files build `MockDataSource` (directly, or through
   `tests/chat/helpers.ts`, `tests/contract/helpers.ts`, `src/server/datasource/index.ts`). Its class composes all 21
   domains as fields, the domains call each other through `ctx.ds`, and its static closure is **594 files**. Each leaf
   above is real use: `domains/time.ts → views/time.ts → … → overlap-flags`, `mock/priority.ts → engines/priority/rank`,
   `mock/needs.ts → engines/needs/registry → every provider`. No barrel sits on these paths, so a thinner barrel cannot
   cut them, and a dynamic `import()` would not either (vitest counts dynamic imports, rightly).
2. **Engine barrels (the fixable part).** 98 import sites in 85 files inside `src/engines`, the DataSources,
   `src/server/views` and `tests` imported an engine barrel (`@/engines/activity`, `@/engines/priority`, …) and so
   every module of that engine. All now import leaves by path. `src/engines/use-cases/index.ts` held code
   (`mentionsOf`); it moved to `use-cases/mentions.ts` so the barrel only re-exports. The barrels themselves are
   unchanged re-export shims: their callers outside this chunk (`src/projections/*`, `src/server/forecast/*`,
   `src/server/time/week.ts`, `src/lib/canvas/prefill.ts`, `src/db/schema/use-cases.ts`, two job handlers,
   `scripts/*`) compile without a change.
3. **What keeps `overlap-flags` and `hash` above 40 outside the mock** (files this chunk could not edit):
   `src/components/domain/index.ts`, `src/components/kit/index.ts`, `src/components/shell/index.ts` and
   `src/components/detail/index.ts` (component barrels: ≈20 UI tests reach `ActivityRow → … → overlap-flags`);
   `src/projections/activity.ts` (real use of `overlap-flags` and `propose`) and `src/jobs/index.ts → handlers/enrich →
   projections/run`; for `hash`, the priority and Home tests (real use) and `db/policy-map → priority/score`.
   With the component barrels removed from the graph, `overlap-flags` outside the mock would be 31.
4. **`src/db/queue.ts` (132).** Not a barrel problem. The mock reaches it through
   `mock/health-setup.ts → src/ops/doctor-service.ts → src/ops/checks/data.ts → src/jobs/handlers/kv-backfill.ts`, and
   outside the mock through the job registry, the scanner store and the worker (36). One mock edge was fixed here:
   `mock/domains/health.ts` imported three pure view functions from `datasource/db/spend.ts`, which pulls the 2,540-line
   scanner store; they now live in `src/server/views/health.ts` (db/spend re-exports them). The count did not drop
   because the doctor path remains; that one is in `src/ops/**` (another lane's files).
5. **Setup files.** `tests/setup/ledger-gaps.ts` imports `src/db/ledger.ts` (drizzle-orm's `sql` only; no client, no
   pg). Setup files are not part of `related`; nothing heavier is loaded per test file.

## 4. What it would take to reach < 40 overall
The fan-out is the shape of the mock: one object that composes every domain. Two options, both larger than this chunk:
- **A per-domain mock for tests** (`createMockDataSource({ domains: ['drafts'] })` or a `MockCtx` plus the domain
  classes a test names), with cross-domain calls behind narrow interfaces instead of `ctx.ds.<domain>`. Tests that
  exercise one domain (outbox, feedback, history, onboarding…) then stop importing every engine. This is a design
  decision for the DataSource owner, not an import-path change.
- **Accept the hub** and treat the ~100 mock-DataSource files as an integration tier (`vitest related` always selects
  them, as it does now), and keep the `outside mock` count as the metric for engine changes.

Smaller follow-ups that do not need a decision: route the component barrels' callers to leaves (components lane);
move `mock/health-setup.ts`'s use of `ops/doctor-service` behind a pure payload builder (ops lane); `src/projections/*`
to engine leaves (projections lane).

## 5. The guard
`tests/hygiene/engine-fanout.test.ts`: for the five leaves, `outside mock` must stay under 40 where it is (a ratchet
just above today's count for `overlap-flags` 55 and `hash` 50), `related` may not pass its ratchet, and no file in
`src/engines`, `src/server/datasource/{mock,db}` or `src/server/views` imports an engine barrel. CONTRIBUTING.md
"Barrels stay thin" says the rule.
