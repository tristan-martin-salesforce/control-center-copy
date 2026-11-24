# Assistant evals

Golden sets for the Assistant (D-81 routing, the eleven tools, D-100 act, prompt injection). They run in the `evals`
project (`npm run test:evals`; the project includes `tests/evals/**/*.eval.ts`), offline and free: no model, no
network, no cassettes. Each eval prints its agreement line at the end of the run.

| File | What it guards | Model |
|---|---|---|
| `routing.eval.ts` + `routing.cases.ts` | Auto routing: a turn → haiku / sonnet / opus, with a one-line why | none (the router is deterministic) |
| `tool-choice.eval.ts` + `tool-choice.cases.ts` | the first tool for an ask, read from the served descriptions (`chatToolsFor`) | `picker.ts`, a fake that picks by description |
| `safety.eval.ts` | act on the named item only, never send/post/budgets/dry run/SEC-5 keys, the raise-hand and plan cards, no image on render | real `callChatTool` and runner over the mock DataSource and the fake model |
| `injection.eval.ts` + `injection.fixtures.ts` | untrusted Slack/Gmail/Drive/Calendar/ledger text is marked and never becomes a call, a card or a draft | same |

`harness.ts` holds the fakes: the real chat host over the mock DataSource with every write method counted
(`watchedHost`), a tool context per user turn (`turn`).

## Add a case

- **Routing:** add an object to `ROUTING_CASES`: `text`, optional `choice` / `setting` / `previous` / `dayLeftUsd`,
  the `expect`ed model, and `why` in one line (the rule it guards). A miss is either a router defect (fix the rule in
  `src/llm/chat/router.ts`, add a unit test in `tests/chat/router-rules.test.ts`, amend D-81 in one line) or a case
  that encodes taste (fix the case).
- **Tool choice:** add `{ ask, expect, why }` to `TOOL_CHOICE_CASES`. If the picker disagrees, read the ranking in the
  failure message. When two descriptions really do read alike, sharpen the description in `src/llm/chat/tools.ts`
  (say what the tool is for in its first sentence, or add a redirect: `To find it by words: use search instead.`).
  Change `picker.ts` only for a reading bug (a tokenizer slip), never to fit one case. The picker reads a "…: use X
  instead" sentence (if the ask shares a word with it) and a "(call plan first)" rule; it does not understand
  negation or counts, so a case like "snooze all six of these" (a list, so propose) is beyond it and belongs in a unit
  test, not here.
- **Safety / injection:** add an `it` (or a fixture in `INJECTIONS`: it runs through every `search` / `fetch` call for
  its source in `READS`). Assert what must never happen (a receipt, a write, a send), not the model's wording.
  Placeholders only: `example.test` hosts, invented names.

## Cassettes

None are used: the router is deterministic and the picker reads descriptions, so there is nothing to record. If a
future eval here needs a model, follow `tests/evals/scanner` (a cassette per case keyed by the ledger request hash,
`src/scanner/completion/cassette.ts`): a changed prompt or skill version changes the hash, so re-key by re-recording
(the scanner's `record-*.ts` scripts, run once against a live model by the owner) and commit the new file. A stale
entry (an unused hash) fails the eval, so a re-key never leaves old answers behind.
