# Real mock seed (SEED-map)

Turns Tristan's real raw context into the mock seed, so the mocked UI feels like his actual day.

**The generated seed is real data. It stays on this Mac and never goes into git.**

| What | Where |
|---|---|
| Raw gathered context (input) | `~/Library/Application Support/command-center/fixtures/raw/*.json` (chmod 700 dir) |
| Private curation overlay (input) | `~/Library/Application Support/command-center/fixtures/overlay.mjs` |
| Voice profile (optional input) | `~/Library/Application Support/command-center/voice/profile.json` |
| Generated seed (output, chmod 600) | `~/Library/Application Support/command-center/fixtures/seed.json` |

The mock loads `seed.json` automatically when it exists (`src/server/datasource/mock/seed-loader.ts`);
otherwise it falls back to the committed placeholder `src/mock/seed.example.json`.

## Regenerate

```bash
npx tsx scripts/seed/build-real-seed.ts     # validates against the Seed zod schema, then writes seed.json (chmod 600)
PORT=4349 npm run dev:web                    # restart the mock to pick up the new file
```

The script **fails loudly and writes nothing** if the seed does not validate (readable zod issues), if a
reference dangles (work item → initiative / event / NBA / run …), or if anything credential-like survives
into the output.

Check today's capacity on the seed the mock loads (numbers only by default, safe for logs):

```bash
npx tsx scripts/seed/capacity.ts                  # at the seed's asOf + 2 min (08:22 on the real seed)
npx tsx scripts/seed/capacity.ts 13:45            # another time of the seed's day
npx tsx scripts/seed/capacity.ts --has w_q4_log   # is this item among the pull-forward suggestions?
```

## How it is split (so no data is committed)

- `lib.ts`: time helpers (Mountain Time), excerpt hygiene (`redact`, `trunc`), the final credential guard.
- `mappers.ts`: **generic** raw → seed mapping: opps, accounts, Claim/Check list, calendar events (attended /
  missed / declined), activity rows (Org62 events + autopilot rows, including the unconfirmed 10/26–11/3
  rows and the "no Solutions Events after 10/23" gap), Claude sessions → agent runs (with `claude://`
  deep links using the desktop `hostSessionId`), connectors, scan runs, event log.
- `overlay-contract.ts`: the **shape** of the private overlay (no data).
- `build-real-seed.ts`: loads raw + overlay, fills defaults, ranks, validates, checks references, writes.
- `overlay.mjs` (**private, not in the repo**): the curated narrative: initiatives, work items and their
  purpose/why/evidence, NBAs and drafts in Tristan's voice, briefs, rank reasons, spine slots, chat, scenario.

Nothing in this folder contains a customer name, Org62 id, Slack id or message body. If you need to change
the story, edit `overlay.mjs`, not the script.

## Rules

1. Never commit `seed.json`, `overlay.mjs`, or anything from `fixtures/`. `git status` must show no data files.
2. Read-only: the builder makes no connector calls; it only reads local files.
3. Credential-like text is redacted from every excerpt (`redact` in `lib.ts`), meeting-link passcodes are
   stripped, and `assertNoCredentials` scans the whole output. Rotate and re-gather if a raw file ever
   contains a real secret.
4. Excerpts are trimmed to ~280 characters.
5. The seed's "now" is Thu 2026-11-05 08:20 MT (`America/Denver`). On load the mock shifts every date so
   that moment lands on today and keeps the time of day.

## Effort estimates

Overlay `effort` is the work **still to do**: `youMin` is hands-on minutes only and errs low (reply or post
5–15, approve 2–5, review 10–20, re-auth 2, a build = kickoff ~10 + review ~20); agent, tool and
Claude-session time goes in `agentMin` and never counts against the day. A step that already ran (an
estimator run, a finished agent analysis) leaves `agentMin: 0`. Items without an `effort` get the engine's
per-kind default (`src/engines/priority/estimate.ts`). The Today header counts only today-scoped work (due
today, start-by today, or pinned), so a realistic seed reads "Fits" with time open, not "overbooked".

## Notes on the mock

The mock re-ranks work items at load with the SE IC policy (`rank.ts`), so Top 3 is decided by item features
(`signals.boost`, due, served meeting, deal value), not by the seed's stored `rank`. The overlay's `order` is kept
equal to that computed order so "Re-rank ready" starts at 0. After adding or changing items, check the order
with a throwaway script that builds a `MockDataSource` from the seed and prints `store.all('workItems')` ranks.
