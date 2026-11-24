---
skill: extract-use-cases
version: 1.0.0
kind: judge
model: claude-haiku-5-5
effort: low
budget_usd_per_call: 0.005
max_calls_per_pass: 12
---

# Use cases to add: the model's part

The `use_cases.extract` job (src/jobs/handlers/use-cases-extract.ts) reads the last 21 days of Gemini notes, customer meetings, Slack threads and mail threads for **use cases**: a business problem a customer wants to solve with Salesforce products (an agent, a Data 360 capability, analytics). Each one becomes a candidate in Activity ▸ Needs you ▸ Use cases to add, where the seller accepts it (the app then drafts the VDP item and the Org62 row, both applied by the seller), edits it, or rejects it with why.

## Who does what

1. **Rules first** (src/engines/use-cases/extract.ts). A source with no customer counterpart (an internal-only meeting, a team channel) yields nothing. Use-case cues ("they want to …", "looking to replace …", "a working demo of …", "the POC scope for …", "agreed to prove … first", "use case: …") with a product or a capability named are **sure** and need no model.
2. **The model only for the unsure ones**: "asked for …", "asked whether X can …", "replace / automate …" alone, or a strong cue with nothing it could be built with. ONE call per source, all of that source's unsure sentences numbered in it.
3. **Code decides the rest.** The opportunity is the attribution engine's (`attribute()`, its learned rules); dedupe against VDP, Org62 and the other candidates is deterministic (src/engines/use-cases/similar.ts); staging is the existing Outbox paths. The model never picks an opp, never sees the opp list, never invents a sentence.

## The call

- Tool-less, one turn, through `ModelProvider.complete()` (tier `fast`, Haiku). The statements are redacted before they are sent (`redactText`).
- System prompt: the one in src/engines/use-cases/confirm.ts (`confirmRequest`). It says what a use case is and is not (a question, a task, scheduling, pricing, legal, a demo detail is not), and asks for strict JSON:
  `{"items":[{"i":1,"useCase":true,"title":"…","problem":"…","product":"…","outcome":""}]}`
- The parser (`parseConfirm`) keeps only numbered items that exist, with a title of 3+ characters; anything malformed is "not a use case". A sentence the model says no to is dropped (precision first).
- Wording: title 2 to 6 words, Title case, no customer name; product one of the listed products or null; outcome a KPI named, or empty.

## Cost and spend

- One hold per pass on the spend governor (src/llm/spend/governor.ts, scope `job`, skill `extract-use-cases`): estimate from history (the static table before 10 samples), hold p90, tick after every call. Past the hold the pass raises a hand (a SPEND.ASK) at the next source and stops; what it confirmed stays. A day with no room skips the model; the rules' candidates still land.
- Each call is one llm_calls row (purpose `classify`, skill `extract-use-cases`, prompt version `extract-use-cases@1.0.0`, the daily budget), keyed `ledgerHash(model, version, system, user)`: the same hash a cassette (src/scanner/completion/cassette.ts) replays offline in tests.
- At most 12 calls a pass, each under $0.005.

## Update rule

Change the prompt only with its version (here and `EXTRACT_USE_CASES_VERSION` in confirm.ts), and re-key the cassettes the tests replay (tests/use-cases/extract-job.test.ts).
