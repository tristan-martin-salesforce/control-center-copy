# D-81: Assistant: Auto model routing and one persisted session per thread

- **Status:** Accepted · planned, phase 2 (chunk p2-assistant-v2) · as of 2.0 (2026-11-21): built (0035), amended below
- **Date:** 2026-11-20
- **Source:** H-6 (touches *Local data*; explicit yes given). [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 05](../reviews/2026-11-20-holistic/05-assistant.md) D1/D2, §5-6

## Context
The Assistant defaults to one model for everything and re-sends a thread's history every turn. "Allow more" cannot truly resume, because nothing holds the SDK session.

## Decision
- Default model **Auto**: Haiku 5.5 first, Sonnet for list mode, drafts and a retry, Opus only by the user's choice.
  - *Amended 2026-11-21 (Assistant evals, `tests/evals/assistant/routing.cases.ts`):* as built, Auto sends research and multi-step plans to Opus; a short follow-up keeps the previous turn's intent and tier, a turn after a failed Haiku turn goes to Sonnet, and with the day's line nearly spent Auto steps down to the highest tier whose per-message line fits (the user's own choice always wins).
  - *Amended 2026-11-21 (P31-1, P31-2):* "continue", "go on" and "keep going" are follow-ups, so after a Steps-per-message stop they keep the stopped turn's tier and continue its answer (the stop carries `RATE.CHAT.STEP_LIMIT`); "remember" is not an act word, so a question about memory is a lookup.
- One SDK session per thread; transcripts (full message bodies) are persisted under `~/Library/Application Support/command-center/`, in app state, never in the repo or logs.
- Assistant v2: 11 tools (incl. a read-only `query` over curated views and a `run` class), read / run / stage / deny per route, a plan card above an estimate threshold, a raise-hand card (D-80), a skill cut to about 6 KB with on-demand playbooks.

## Consequences
- *tenet: Local data, privacy-safe logs* holds: bodies stay on this Mac and out of logs.
- Every send or apply route stays `deny` for the Assistant (`tests/safety/route-classification.test.ts`).

## Supersedes
Amends D-58 (general abilities stay; routing, sessions and the tool set change).
