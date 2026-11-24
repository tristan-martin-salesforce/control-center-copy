# Engine guidelines

These are the rules every reasoning engine in Command Center follows. A reasoning engine is anything that turns facts into a suggestion, a rank, a verdict, a draft or a proposed change. The rules generalise [D-103](decisions/0103-coverage-and-event-driven-dc.md) and [review 03](reviews/2026-11-23-activity-ux/03-dc-engine-flex.md) §3 ("the engines read facts, and every special case becomes data") to every engine. They hold under [TENETS.md](TENETS.md). How each engine works in detail is in [reference/ENGINES.md](reference/ENGINES.md) and [ARCHITECTURE.md](ARCHITECTURE.md). This page says how any of them may change. Every change to a rule, weight, threshold or prompt gets a line in [engines/CHANGELOG.md](engines/CHANGELOG.md).

**Read this before** any work under `src/engines/**`, `src/projections/**`, `src/llm/**`, `src/scanner/**` or `src/jobs/handlers/**` that changes what an engine decides.

**The owner's guidance (2026-11-23), which these rules write down:** don't build each case on its own; make the scanners and read-ins smart enough and fix how the engine reasons. Log in the engine why each change was made. Balance against token cost. Keep past reasoning auditable. Not perfect, but flexible. Pick a fact up from either direction.

## The ten rules

| # | Rule | Why | How to check |
|---|---|---|---|
| 1 | **Facts as data, not code.** Who I cover, what I own, templates, products, thresholds and weights live in Settings, the team pack (`config/team.json`, D-28), the persona (`src/personas/`) or a table the engine reads. They never live in a prompt or a constant that only a build can change. A default may live in code (`DEFAULT_WEIGHTS`) if a caller can override it. | *Config over code for people and teams*: a teammate changes a fact without a release. | Grep the engine for literals that name a person, an account or a product, or a number with a business meaning. Each one is either a default a caller overrides, or a finding. |
| 2 | **Event-driven, not scheduled.** Re-evaluate on the events that can change the answer: a new item, logged time, a DC or SFR seen, a call, a Settings save. Run a cheap deterministic check first: fingerprint the inputs, and stop if the fingerprint matches the last verified run. Then run the deterministic rules. A model call comes last, and only when the rules cannot answer. A schedule is a 0-token safety net that catches missed events. | Calm and cheap: nothing is asked again when nothing changed (D-103 b). | Every model call in the engine has a skip path in front of it, pinned by a test ("same inputs: 0 calls"). Every row in `src/worker/schedules.ts` says whether it is the safety net or the only trigger. |
| 3 | **General rules, no special cases.** Handle a new situation by adjusting a rule, a weight or a data row, and record the reason (rule 9). Never add a branch for one account, one person or one customer. | Special cases rot, and they leak names into the repo (`npm run scan:private`). | No `if` on an id, name or domain literal. The new case is a fixture row (rule 10) that passes the general rule. |
| 4 | **Either direction.** A fact can arrive from any source (Org62, Slack, Calendar, Drive, Gmail, the user) and in any order. The engine reconciles the sources rather than trusting one feed. On a conflict the external record wins (EDGE-CASES rule 7), and the conflict is shown, not overwritten. | The owner's "pick it up from either direction": a DC made in Org62, a claim on my AE's SFR and a call of mine are one fact. | For each output, list the sources that can produce or settle it. A test feeds the same fact from two of them and gets one result, not two. |
| 5 | **Why, always.** Every suggestion, rank, verdict and draft carries its evidence (links) and the rule that produced it: a code, a sentence and the rule version. The UI shows it in one fold. The audit keeps it (`attribution_outcomes`, `closure_checks`, `priority_feedback`, `scan:explain`). The sentences come from facts, not from a model, unless the output is itself a draft. | North star *Legible*; *Provenance on everything*. | The output type has a `reasons` or `why` field that is non-empty in every fixture, and the UI test finds it on the row. |
| 6 | **Overrides are remembered.** A dismissal, correction, pick or "Not done" is data the engine reads on its next run. It is keyed so the same fact cannot come back by another path. Each engine has one documented resurface rule that says which new fact brings an item back. For DCs that is 2 h more logged, joining the team, or one call on the account after the dismissal (D-103 d). Nothing else overrides it. | *Suggest, then learn*: a correction is never overridden. | A test dismisses an item and reruns with the same inputs (the item stays hidden). It then adds the resurface fact (the item returns once, with its reason). |
| 7 | **Estimate → warn → pause → continue.** Anything that spends tokens goes through the one spend governor (D-80, `src/llm/spend/`): an estimate before the run, a hold that raises a hand, and continue on Allow. A bulk run shows a cost line first (count × p50/p90 from `llm_calls`). Use the cheapest model the eval says is good enough. Escalate only where data shows escalation changes the answer. Caps exist only for real external limits, the user's budget or safety. | Token cost stays under control without arbitrary caps. | No direct provider call outside `src/llm/`. Every model call in the engine carries a governor key. A bulk entry point has an `estimateOnly` path that a test calls. |
| 8 | **Never write without approval.** An engine proposes a draft, a canvas row, an Outbox action or a proposal row. It never writes to Slack, Gmail, VDP, Org62, Calendar or Drive itself. The only writes are the Outbox actions the user Applies (D-47, D-49, D-56, D-90) and VDP autopilot inside its policy (D-60). A local auto-close follows *Suggest, then learn*: it shows its reason, a link and Undo. | *Nothing leaves without approval*; *Draft, don't send*. | The engine imports nothing from the `src/outbox/` adapters or a connector's write path. Its outputs are rows a human Applies. |
| 9 | **Changes to the engine are logged.** Each rule, weight, threshold or prompt change gets one line in [engines/CHANGELOG.md](engines/CHANGELOG.md): the date, the rule version (`dc@3`), what changed, why, the decision or review that asked for it, and the test that pins it. The code keeps the current version beside its constants and stamps it on every output, so the UI's why can cite it. | The owner's "a log in the engine saying why each change was introduced"; past reasoning stays auditable. | A diff that touches a weight, threshold or prompt also touches the CHANGELOG and bumps the version. Until B-119 lands (a constants snapshot test; proposed), the reviewer checks it. |
| 10 | **Tests use fixtures of real shapes, with placeholders only.** Each rule has a fixture case in the shape the real source returns (an Org62 row, a Slack message, a Calendar event), with placeholder names and ids (`sample-data/`, `src/mock/seed.example.json`). Model calls use the scripted fakes. Golden cases live in `tests/evals`. | North star *Trustworthy*, and nothing private in the repo. | `npm run scan:private` is clean. Each CHANGELOG line names a test that fails without the change. |

## How to add a rule (or change one)

1. **State it as a general rule.** Write the situation as a rule over facts ("a covered AE's deal is suggested unticked"), not as a case ("Jane's deals"). If the rule changes how time, DCs or use cases behave, change its row in [EDGE-CASES.md](EDGE-CASES.md) first (D-85).
2. **Find where the fact lives.** If the engine needs a fact it cannot read, add it as data (a Settings field, a team-pack key, a column), not as a constant (rule 1). That is a contract change, so raise it in the chunk brief.
3. **Edit the rule** in the engine, bump its rule version, and make the why sentence state the new reason (rule 5).
4. **Add the fixture case** that fails before the change and passes after it (rule 10). If the rule sits in front of a model, also add the "same inputs: no model call" case (rule 2).
5. **Add the CHANGELOG line** in [engines/CHANGELOG.md](engines/CHANGELOG.md) (rule 9).
6. **If it spends tokens,** put the estimate in the chunk's notes and route the calls through the governor (rule 7).

## What is NOT an engine change

None of these needs a CHANGELOG line or a version bump:
- a **Settings edit** by the user (adding a covered AE, a product, a threshold value or an autonomy level);
- a **team-pack, seed or sample change** (`config/team.json`, `src/mock/seed*.json`, `sample-data/`);
- a **learned rule** written from a pick (`mapping_rules`), or a dismissal;
- a copy, layout or UI change that leaves the decision the same;
- a refactor that keeps every fixture's output the same (the tests prove it).

A new *default* for any of these (the default split, a default threshold) is an engine change.

## Where each engine stands (audit, 2026-11-23)

The full table, with file:line evidence for every engine against all ten rules, is [review 04](reviews/2026-11-23-activity-ux/04-engines-audit.md). In short:

| Engine | Follows | Furthest off on |
|---|---|---|
| Resolution check | 2-6, 8-10 | 7: no per-job hold (B-123) |
| Priority@2 / Needs | 2, 5, 6, 8-10 | coverage is not a people-tier input (B-122) |
| Assistant routing and spend | 3-8, 10 | 9: no router version (B-119) |
| Scanner interpret | 3-5, 7-10 | 2: only Slack skips unchanged input (B-121) |
| Use cases | 2, 4, 7, 8, 10 | 6, 9: no resurface rule, no reason log (B-124, B-119) |
| VDP autopilot / identity | 3-5, 8, 10 | 2, 7: a 30-min poll; identity has no governor hold (B-126, B-123) |
| Inbox reply drafts | 3, 6, 8, 10 | 1, 7: a hard-coded model; voice has no governor (B-125, B-123) |
| Home / briefs | 3, 5-8, 10 | 2, 9: briefs hash after the paid call; Home has no version (B-120, B-119) |
| Attribution / DCs | 5, 7, 8, 10 | 2, 9: schedule-only, no fingerprint, no version (D-103 chunks 1-5, B-126) |

**What D-103 changes for other engines:** coverage becomes a "who matters" fact for priority and the inbox. The event bus and fingerprint skip become one shared mechanism, with schedules as safety nets. The decision log and rule versions cover every engine. One resurface rule covers every dismissal. Backlog B-119..B-126.
