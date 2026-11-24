# D-100: The Assistant's `act` applies at once only on the item the turn names

- **Status:** Accepted, built · as of the post-2.0 chunks (2026-11-21): the same own-words test also gates `remember` for every-thread preferences (SEC-8) and `run reauth`, which needs a sign-in ask naming the connector (SEC-9, P25-1)
- **Date:** 2026-11-20
- **Source:** [wave 1/2 review](../reviews/2026-11-20-holistic/14-wave12-review.md) W12-2

## Context
D-58 said the Assistant's own safe actions (snooze, pin, done, not mine, reopen) run at once when the user asked for them, else they are a card. "Asked" was the router's regex reading of the whole turn (`intent === 'act'`), so inside an act turn the model could call `act` on any item id, including one the user never named (a stale or guessed id), and `done` / `not_mine` landed at once. Local, audited and undoable, but not what D-58 meant.

## Decision
- A work-item action applies at once (receipt with Undo) only when the turn is an `act` **and** its target is the item the turn names: the item's id or whole title appears in the user's text, or the text carries the title's own words (at least two of them and at least half, so "snooze the Globex VDP update" names "Update the VDP for the Globex expansion"), or the item is one of the message's context items (the "Looking at:" chip, an @ mention). `src/llm/chat/tools.ts` `actTargetNamed`.
- Any other target is staged as a card for the user's Apply, with the same change set.
- `rerank` keeps running at once in an act turn (it changes no item); settings changes keep staging; sending and budgets stay refused.

## Consequences
- A model that picks the wrong id produces a card, never a change. A user who names the item, or is looking at it, still gets one-step actions.

## Amendment (2026-11-21, SEC-8, SEC-9, `4790248`)
- The same test now gates two effects outside `act`: `remember {scope: preference}` keeps a pinned every-thread preference only when the user's own words ask for it, and `run reauth` opens a sign-in window only for the connector the user names (`src/llm/chat/user-said.ts`); otherwise the tool refuses and the model asks the user.

## Supersedes
Amends D-58 (the allow rule only).
