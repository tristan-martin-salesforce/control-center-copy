# 22 · Max-lines split (maintainability ask #11)

Chunk `post-max-lines`, 2026-11-21. Goal: split every file the `max-lines` lint warns about (600 counted lines;
blank lines and comments not counted) into files under the limit. Behaviour is unchanged, exported names are unchanged,
and callers need no edits.

## 1. Result
- `npm run lint`: **27 → 8 warnings**, 0 errors. Of these, **max-lines went from 22 to 3** (the other 5 warnings are
  the same ones as before and none of them is in a file this chunk touched).
- `LONG_FILES_GRANDFATHERED` (exempt from the 1,000 error) went from **9 entries to empty**.
- No new layer-rule warnings. Every new file is under 600.
- Tests (all green unless noted):
  - `npm run typecheck` passes.
  - `npm test`: 4,601 passed and 1 failed. The failure is `tests/feedback/agent.test.ts` "refuses … node_modules". It
    is an environment artefact, not caused by this chunk: `node_modules` is a symlink out of the worktree (as the brief
    sets it up), so the path gate says "outside the repo" instead of "private".
  - `CC_TEST_DB_SUFFIX=postlines npm run test:db`: 88 files, 980 passed.
  - `npm run smoke:crawl -- --mock --port 4396`: 43/43 ok (Home, Today, Deals, Deals ▸ Missed, Settings, Activity).
    `/dev/kit/domain` is not in the crawl, so it was screenshotted and checked by eye.

## 2. The convention (now one line in CONTRIBUTING "Files stay small")
- Parts go next to the file as **`<name>.<part>.ts(x)` siblings**: no folders, and relative import paths do not change.
  The original path stays the **entry** and re-exports every public name (`export { … } from './x.part'`,
  `export type { … }` for types).
- **Parts never import the entry.** Dependencies flow part → part → entry, so there are no runtime import cycles. The
  only place a part refers back to its entry is a type-only import (erased at build time), and none is left.
- **A long class is split into abstract layers.** Members move unchanged into `abstract class <Name><Layer>` files
  chained by `extends`; the exported class extends the last layer and keeps its `implements`. `private` became
  `protected` so the layers can share members; that is the only change to class code. Forward calls are avoided by
  layer order; there is one exception (`skill-runner.triage.ts` declares `protected abstract runOnce(...)`).
- The splits were made mechanically with the TypeScript AST: whole top-level statements and members moved as text,
  with imports recomputed per file. The script refused any split that would have left a part importing a value from
  its entry, or left two parts importing each other.

## 3. Files

Counts are the lint's counted lines (eslint `max-lines`, skipBlankLines + skipComments).

| File | Before | After (entry · parts) | How | Tests that reach it |
|---|---:|---|---|---|
| `src/scanner/store-db.ts` | 2,268 | 242 · base 403 · items 460 · proposals 402 · finish 388 · shared 308 · rows 136 | Class layers `DbScannerStoreBase ← Items ← Proposals ← Finish ← DbScannerStore`; top-level helpers to `.shared`/`.rows`. `recordSpend` stays in the entry because `tests/ledger/writers.test.ts` names `store-db.ts` as the one `llm_calls` writer. | 24 direct (tests/db/scanner/*, db/ledger, db/llm, db/projections, connectors/registry+sources, …) |
| `src/projections/run.ts` | 1,336 | **989** · model 203 · helpers 174 | Only the db-free code moved (types, constants, loaders, matcher, note/missed/date helpers). **Partial**, see §4. | 5 direct: tests/db/projections/db, db/time/roundtrip-db, projections/mappers, opp-match, engines-org62/engaged-hours |
| `src/engines/home/build.ts` | 1,300 | 185 · ctx 172 · gaps 256 · cards 154 · rows 321 · sections 247 | Top-level seams: context, gap rules, cards, rows, ribbon/strip/masthead/footer; `buildHome` stays. | 9: tests/home/*, personas/lane-b, safety/pending-never-done, ui/home-plain-words |
| `src/scanner/runtime/scanner-runtime.ts` | 1,248 | 136 · plan 454 · outcome 195 · jobs 410 · shared 98 | Class layers `ScannerRuntimePlan ← Outcome ← Jobs ← ScannerRuntime`; the entry keeps the on-demand API and the loop. | 22: tests/scanner/runtime/*, scanner/stress, db/scanner, db/ledger, llm/spend/pause, onboarding/first-scan-wait, … |
| `src/scanner/store-memory.ts` | 1,104 | 217 · state 315 · runs 356 · rows 239 | Class layers `InMemoryScannerStoreState ← Runs ← InMemoryScannerStore`; errors, rows and range helpers go to `.rows`. | 37: every scanner test (tests/scanner/helpers), db/worker/store-memory.spec, completion, llm, trace |
| `src/projections/activity.ts` | 948 | 17 · model 235 · plan 442 · moves 238 | Types + small helpers, `planWeek`, and its adopt/proposal/Org62 helpers. | 6: projections/*, time/roundtrip, activity-note, internal-activity, engaged-hours |
| `src/components/deals/MissedView.tsx` | 902 | 25 · rows 397 · sweep 496 | Row, dismiss form, verdict and stacked sections; the sweep component. | tests/ui/deals-plain-words; crawl /deals/missed |
| `src/server/datasource/db/store/work.ts` | 889 | 281 · columns 39 · load 239 · evidence 127 · proposals 205 | Lock/field columns, loading work items, evidence, initiatives and proposals. | No direct test; the db DataSource suites (test:db db-datasource) reach it |
| `src/server/datasource/db/store/projections.ts` | 801 | 376 · activity 404 · ext 30 | Org62 Events, activity window and blocks; shared ext merge and types. | tests/db/projections/db, db/hygiene/hygiene-db |
| `src/engines/activity/use-cases.ts` | 798 | 161 · model 270 · plan 403 | Vocabulary, keys and types; `planUseCases`. | 8: tests/time/use-cases*, canvas-review*, roundtrip, landings, attribution/prefill, db/vdp/use-cases-db |
| `scripts/build-example-seed.ts` | 762 | 262 · world 199 · work 310 | Seed data: the world (people, accounts, opps, calendar) and the work. | No test. Checked by running it: the generated `seed.example.json` is **byte-identical** to the unsplit script's output |
| `src/components/domain/NbaCard.tsx` | 751 | 554 · types 79 · parts 140 | Props/types and primary helpers; NewDot, StatusLine, WhyPopover, PlanBlock. | No direct test; the Home crawl and `/dev/kit/domain` render it |
| `src/llm/skill-runner.ts` | 737 | 457 · shared 138 · triage 186 | Class layer `AgentSdkSkillRunnerTriage` (options + triage pass); helpers to `.shared`. | 21: tests/scanner/runtime/skill-runner, llm/*, connectors/runtime+parity, scanner/stress, db/llm/measure, … |
| `src/components/composer/Composer.tsx` | 731 | 53 · body 538 · status 105 · types 48 | `ComposerBody`, send status, types; the entry keeps Composer, Shell and Skeleton. | src/components/composer/__tests__/components.test.ts, tests/compose |
| `src/server/datasource/db/chat-be6.ts` | 716 | 399 · reads 240 · shared 112 | Class layer `DbChatBe6Reads`. `searchLedger` stays in the entry because `tests/ops/log-redact.test.ts` reads its log line from `chat-be6.ts`. | No direct import; tests/db/chat (db), tests/ops/log-redact (source), tests/events/topics (source) |
| `src/db/changeset.ts` | 685 | 104 · core 421 · undo 172 | Change set core and row writers; undo. The entry keeps apply/reject proposal. | 55 (tests/db/**, the whole db suite) |
| `src/engines/activity/propose.ts` | 640 | 183 · meetings 268 · evidence 212 | Meeting/travel entries; frame/evidence entries. | 7: tests/engines-org62/*, time/internal-activity, not-on-team-approval |
| `app/dev/kit/domain/_kit/KitGallery.tsx` | 636 | 325 · sections 297 | The gallery's later sections. | No test; screenshotted `/dev/kit/domain` (renders) |
| `src/contract/vdp.ts` | 631 | 195 · coverage 451 | Coverage/steps/tree/push schemas; details stay. | Everything through `@/contract` (route-drift, contract parity, every VDP test) |
| `src/server/datasource/db/closure.ts` | 619 | 522 · record 106 | Closure record mapping; re-evaluation stays. | tests/db/datasource/db-only, db/reeval/*, integration/policy-map |

No folder barrel was created, so no import-smoke test was added.

## 4. Left, and why
| File | Counted | Reason |
|---|---:|---|
| `src/components/onboarding/steps.tsx` | 677 | Owned by another builder (`src/components/onboarding/**`). |
| ~~`src/components/today/TodayPage.tsx`~~ | 679 | **Done 2026-11-21 (post-small-followups).** The visual sections were already components (`DayTimeline`, `RunOfDay`, `AgentPlan`); the mass was `TodayView`'s handlers. Moved to sibling hooks, props in, behaviour unchanged: `TodayPage.rows.ts` (`useRowActions`: primary action, hover actions, renegotiate), `TodayPage.plan.ts` (`useAgentPlanActions`: Accept all, Undo / Redo per change; owns `accepting`), `TodayPage.meetings.ts` (`useMeetingState`). `TodayPage.tsx` is 595 lines, no max-lines warning. Guard: Today ui tests green; 1440 shots before / after match. |
| ~~`src/projections/run.ts`~~ | 989 | **Done 2026-11-21 (post-lint-zero)**, the R8 move without waiting for `src/db/store`: the projection layer now reaches the database only through a port. `run.store.ts` (types only) declares `ProjectionStore`; `src/server/datasource/db/store/projections.run.ts` implements it (`projectionStore(db)`) and holds what moved out: `loadMe`, the watermark read/write, the change-set wrapper and write context, the READ ONLY rederive transaction, Settings ▸ Time, the onsite weeks due and the onsite record write, `writeMissedFindings`, and the four schema reads (event mapping, event row id, week sessions, same-meeting rows); the existing store writers are passed through unchanged. The rest split by stage: `run.entities.ts` (Stage A, `projectEntities`), `run.week.ts` (`loadWeek`, `projectWeek`, `weekConfig`: the activity config that was written out three times). `run.ts` is 305 lines (entities 326, week 329, store 288), off `LAYER_GRANDFATHERED`, no new layer warnings. Exported names are unchanged; the options of `runProjections` / `recomputeWeeks` / `rederiveWeeks` take `store` instead of `db`, `accountMatcher` and `projectionsHook` take the store first, and every caller passes `projectionStore(db)` (worker, three DataSource domains, `vdp-assets`, three job handlers, `scripts/time-rederive.ts`, five db suites). Guard: tests/projections, test:db green. |

## 5. Notes for the integrator
- Class layers: `private` → `protected` in `DbScannerStore`, `InMemoryScannerStore`, `ScannerRuntime`,
  `AgentSdkSkillRunner` and `DbChatBe6`. The behaviour is the same. `instanceof` still holds for the exported class
  (and the layers are new supertypes). Tests that reach into members with `(x as any).foo` still work.
- `src/server/datasource/db/store/sidecar.ts` lists `src/projections/run.ts` as a reader of `ext.dcAssigned`. That read
  is now in `run.model.ts` (`loadMatcher`). The file is outside this chunk; it is a one-word doc fix for whoever owns it.
  **Done 2026-11-21 (post-small-followups)**; `tests/data/sidecar.test.ts` now checks every listed reader exists and reads the field.
- `src/mock/seed.example.json` as committed is stale compared with the generator (the unsplit script already writes
  extra fields such as `nextStepRead`). This was there before and was not changed here.
  **Done 2026-11-21 (post-small-followups)**: regenerated; placeholders only.

## 6. Layer grandfather (2026-11-21, post-layer-grandfather)
`LAYER_GRANDFATHERED` in `eslint.config.mjs` went from 7 files to 1, then to 0 (post-last-grandfather: the last entry
needed a port its caller builds, and its CLI moved out of engines). The first six fixes were pure helpers sitting in the
wrong layer, so none needed a port: each moved to `src/lib` (or was already there), the old module re-exports it under
the same name, and the importing file now reads the shared layer. Behaviour is unchanged.

| Entry | Broke the rule with | Result |
|---|---|---|
| `src/engines/activity/note.ts` | `@/llm/redact` | **Done.** It imports `@/lib/redact`, where redaction already lives (`src/llm/redact.ts` is a re-export). |
| `src/engines/activity/suggest-prompt.ts` | `@/llm/redact` | **Done.** Same fix. |
| `src/engines/settle/context.ts` | `@/llm/redact` | **Done.** Same fix. |
| `src/engines/briefs/channel.ts` | `@/worker/schedules` (`nextLocalTime`) | **Done.** The DST-safe slot math (`nextLocalTime` plus its two private helpers) moved to `src/lib/local-time.ts`. `src/worker/schedules.ts` imports and re-exports it, so the worker and `tests/db/worker/schedules.spec.ts` are unchanged. New guard: `tests/time/local-time.test.ts`. |
| `src/engines/vdp/identity-judge.ts` | `@/db/ledger` (`ledgerHash`) | **Done.** `src/lib/ledger-hash.ts` holds `ledgerHash`. `src/db/ledger.ts` is outside this chunk, so it still has its own copy for now. `tests/ledger/hash.test.ts` checks that both give the same output. **Follow-up for the db owner:** make `src/db/ledger.ts` re-export it with `export { ledgerHash } from '@/lib/ledger-hash'`, which removes the copy. *Done in post-last-grandfather.* |
| `src/connectors/google/calendar.ts` | `@/engines/activity/event-kinds` (`isNonMeetingTitle`) | **Done.** The title regexes and tests (`isFlightTitle`, `isHotelTitle`, `isOnsiteTitle`, `isDinnerTitle`, `isHomeWord`, `flightNumber`, `isNonMeetingTitle`) moved to `src/lib/event-titles.ts`. `event-kinds.ts` re-exports them and keeps the shape checks (`spanHours`, `crossesMidnight`, `isMarkerEvent`). The connector imports `@/lib/event-titles`. |
| `src/engines/nba/prompt/complete.ts` | `@/llm/claude-env` (2), `@/llm/usage` | **Done 2026-11-21 (post-last-grandfather).** The file keeps only the port (`Complete`, `CompleteRequest`, `CompleteResult`). `agentSdkComplete` moved to `src/llm/complete-sdk.ts` (built by `createAgentSdkComplete({ queryFn?, gateway? })`, so `tests/llm/complete-sdk.test.ts` drives it with a fake query); the unused `claudeGatewayConfig`/`childEnv` re-export is gone (they live in `src/llm/claude-env.ts`). The voice CLI moved to `scripts/voice/cli.ts` (`npm run voice:profile`, same flags and output) and passes `agentSdkComplete` to the engine; `tests/skills/run-evals.ts` imports it from `src/llm`. `src/db/ledger.ts` now re-exports `ledgerHash` from `@/lib/ledger-hash` (the copy is gone; `tests/ledger/hash.test.ts` checks identity plus a fixed vector). `LAYER_GRANDFATHERED` is empty. Was: **Left.** The port already exists: `Complete`, `CompleteRequest` and `CompleteResult` are the engine seam, and the engines take a `Complete`. What breaks the rule is the real implementation, `agentSdkComplete`, plus a re-export of `claudeGatewayConfig` and `childEnv` that nothing uses. The fix is to move `agentSdkComplete` into `src/llm` (for example `src/llm/complete.ts`) and keep only the types here. Its callers make that a design decision. One is `src/engines/voice/cli.ts`, an entry point that lives inside the pure layer and would then break the rule itself, so the CLI has to move to `scripts/` or be wired elsewhere. The other is `tests/skills/run-evals.ts`. Both destinations are also outside this chunk's files. |

Notes: the `@/engines/nba/prompt` barrel (`export * from './complete'`) lost `agentSdkComplete`, `claudeGatewayConfig`
and `childEnv` when the last entry moved; a grep found no importer of those names through the barrel. CONTRIBUTING
"Where code goes" now names `Complete` among the ports and says entry points (CLIs, workers) live in `scripts/` or
`src/worker`, never inside an engine. The `ledgerHash` follow-up above is done in the same chunk. With the list empty,
the layer rule could move from warn to error (CONTRIBUTING says it does "once the grandfathered sites are fixed"); that
flip is left to the integrator.
