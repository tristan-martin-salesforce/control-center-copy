# Control Center — Plan

> Status: **proposed, awaiting decisions** (`docs/DECISIONS.md`). Date: 2026-10-22.
> Read with: `TENETS.md` (rules), `ARCHITECTURE.md` (how it works), `UX.md` (how it feels), `BACKLOG.md` (every idea, logged).

## Roadmap

| Phase | Theme | You get | Depends on | Parallel with |
|---|---|---|---|---|
| **Now** | **Q3 catch-up kit** (no app needed) | Q3 Solutions Event drafts + DC/VDP gap list, ready to submit before **Fri 10/30 12 PT** | Nothing | P0 |
| **P0** | Foundations + spikes | Repo, contracts, DB, Outbox gate skeleton, app shell, connector harness, answers to auth spikes | — | Now |
| **P1** | Read-only cockpit | **Today / Triage** views fed by Slack, Gmail, Calendar, Gemini notes, Drive (incl. edit sampling), Org62 opps, Claude sessions; reply-needed + meeting next-steps tasks with cross-source merge; done-detection v1; copyable suggested replies | P0 | — |
| **P2** | Time & activity logging | Week timeline, allocation to opp + SE Task Type, Org62 Solutions Event drafts, handoff (links / CSV / Slackbot prompt), read-back verify, QTD hours vs target, Friday ritual | P1 core | P3, P4 |
| **P3** | VDP & Deal Contributions | VDP coverage per opp (the VDP owner's checklist), use-case drafts from notes/decks, gated VDP MCP writes, deck→asset handoff, DC notes → DC upload handoff, upstream vdp-app PR (asset + readiness tools) | P1 core | P2, P4 |
| **P4** | Composer & outbound comms | WYSIWYG Slack/email replies in your voice, Slack/Gmail drafts, gated send, promise extraction ("said by me") | P1 core | P2, P3 |
| **P5** | Planning & goals | Priority engine v2, `⌘K` search, learned rules, Goals view, weekly plan + capacity, morning brief (replaces Cowork 7am triage), commitments ledger (said vs done), meeting prep briefs | P2–P4 data | P6 |
| **P6** | Deep signals + Claude v2 | Claude hooks + `/cc` skill, doc-edit sessions into the time engine (sampling itself starts in P1), git, "start Claude session from task", optional Drive Activity API / browser-tab sampling | P2 | P5 |
| **P7** | Team rollout | `npm run setup` + doctor, team pack, onboarding, packaging; first teammate pilot | P5/P6 stable | — |

```
Now ─────────▶ (submitted by 10/30)
P0 ──▶ P1 ──┬──▶ P2 (time/logging) ──┬──▶ P5 (planning) ──┐
            ├──▶ P3 (VDP/DC) ────────┤                    ├──▶ P7 (team)
            └──▶ P4 (composer) ──────┴──▶ P6 (deep signals)┘
```

**Order of value:**
1. **Now.** Real deadline and manager visibility.
2. **P1.** Stop losing track.
3. **P2.** Q4 hours never lapse again. Q4 starts Nov 1.
4. **P3.** VDP and DC hygiene.
5. **P4.** Live in the app.

P2, P3 and P4 run **at the same time** in separate lanes.

---

## Phase "Now": Q3 catch-up kit (start immediately, separate session)

Building the app is not on the deadline's critical path. A Claude session with Calendar, the Salesforce-Beta (Org62) connector and VDP can produce everything this week. It also works as a prototype of the P2 time engine and the P3 VDP checks, and its scripts and prompts get reused.

**Deliverables** (all drafts; *you* submit):
1. **Coverage audit.** Covers 2026-08-01 to 2026-10-30, calendar vs existing Org62 Events. Lists the gaps: everything since 9/29, plus earlier misses.
2. **Draft Solutions Events table.** One row per unlogged accepted meeting or real work block, with:
   - Subject, Start/End, `SE_Task_Type__c` (verbatim from canvas <task-type-canvas-id>, not catch-all "Solution Creation"), `WhatId` (opp, falling back to the account), `Duration__c`, and the CF flag (external attendee).
   - Output as a CSV for Data Loader plus pre-filled Lightning links. You review it in a sheet or table first.
   - **Spike S7 happens here:** you open one generated link to confirm the fields pre-fill correctly before trusting the rest.
3. **`Duration__c` backfill list** for your 47 existing events (as an Update CSV). Use it only if you confirm reporting reads that field (D-11).
4. **Fix list for the 10 legacy "Sales Engineer Events" (9/29).** Record type is locked, so this is re-create plus delete-by-you (D-12).
5. **DC + VDP gap list per opp.** For each of your 10 opps (plus the non-team opps you log to): does a VDP exist, are Org62 IDs linked, is there a DC note, and is a DC uploaded? Each gap comes with a prepared "DC Comment Upload" Slackbot prompt.
6. **QTD hours summary** (CF / CR / CC) vs the ~250 target, so you know where you stand before your manager or SE Ops look.

**Limits:** Claude transcripts before about 9/22 are already deleted (30-day retention), so non-meeting work before then is reconstructed only from Slack, Drive and git evidence, or from your memory.

**Done when:** you've submitted everything by **Thu 10/29** (one day of buffer) and a read-back shows the events and DCs in Org62.

---

## P0: Foundations + spikes (wave 0 is serial; spikes run in parallel)

**Ownership rules (they prevent parallel-build collisions):**
- `package.json`, the lockfile and root config are owned by the **integrator only**. Builders list their dependencies in their return, and the integrator adds them.
- **Schema:** each domain has its own `src/core/db/schema/<domain>.ts`. Migrations use reserved number ranges per lane: core 0000–0099, P1 0100–0199, time 0200–0299, VDP 0300–0399, composer 0400–0499.
- **Routes and nav:** C0-shell creates a **nav registry** (`src/ui/nav/registry.ts`) and **route stubs** for every view. View chunks own only their route folder plus `src/ui/<view>/**`, and register through the registry without editing the shell.
- `src/app/api/<domain>/**` is owned by the matching domain chunk. `src/app/api/core/**` belongs to C0-shell.

**Wave 0, serial (one builder, Opus):**
- C0-repo: `git init`, Next app scaffold on port 4327, lint/test/typecheck, `CLAUDE.md`, `.claude/agents/*`, launchd plist template.
  - Files: root config, `.claude/**`, `scripts/**`.
- C0-contracts: zod contracts for `SourceItem`, `Connector`, `Task`, `TimeBlock`, `Activity`, `OutboxAction`, `Handoff`. Core schema and migrations, the fixture format, and **synthetic fixtures** so UI lanes can build before live auth works.
  - Files: `src/core/contracts/**`, `src/core/db/**`, `fixtures/synthetic/**`.
- C0-mcp: a shared MCP client wrapper with a **read-tool allowlist**, a per-source token bucket, the shared **mcp-adaptor stdio client and text parsers** (used by Gmail, Calendar, Notes and Drive), and the headless-Claude job runner (Agent SDK / `claude -p`).
  - Files: `src/core/mcp/**`, `src/core/agent/**`.
- C0-shell: layout, nav registry, route stubs, Settings/Health page, empty Today.
  - Files: `src/app/layout.tsx`, `src/app/(shell)/**`, `src/app/api/core/**`, `src/ui/shell/**`, `src/ui/nav/**`.
- *(Deferred to the first outbound lane, P2: the Outbox state machine, approval API and audit log. P1 is read-only.)*

**Spikes (parallel, read-only, each about 1–2 h, ending in a short markdown note in `docs/spikes/`):**

| ID | Question | Pass = |
|---|---|---|
| S1 | Cheapest headless Slack read path: a `claude -p --allowedTools mcp__slack__<read>` job vs an Agent SDK job. Cost and latency per 5-min poll. We never extract the OAuth token | Last 20 DMs + mentions as JSON from a script; cost per day measured |
| S2 | Headless Org62 read: `Org62-Sobject-Read` (after `/mcp`) via a `-p` or SDK job; does the claude.ai "Salesforce - Beta" connector appear in SDK jobs at all? | OpportunityTeamMember SOQL from a script |
| S3 | mcp-adaptor stdio from Node: Gmail, Calendar and Drive read tools, plus output parsers | Typed events, threads and docs from fixtures and live |
| S6 | Agent SDK through the corporate gateway (Bedrock env, `apiKeyHelper`): model IDs, structured output, `canUseTool` deny | A structured extraction runs on Haiku and on Sonnet |

(The VDP direct call is already verified: `tools/list` returned 200. Hook events are confirmed in research 05. S7 moves to the Now kit.)

**Done when:** the app shell runs on :4327 under launchd, the contracts are frozen (v1), and every spike has a verdict that's been folded into `ARCHITECTURE.md`.

---

## P1: Read-only cockpit

**Row actions in P1 are "deep link + copy":** every task opens its source in one click. Reply-type tasks show a **plain-text suggested reply with a Copy button**, made by a simple Haiku/Sonnet call. The rich composer comes in P4. No P1 row is a dead end.

**Wave 1, parallel (6 builders). Each starts from synthetic fixtures, then records redacted live fixtures:**

| Chunk | Files | Notes |
|---|---|---|
| C1-slack | `src/connectors/slack/**` | DMs, mentions, my threads, my sent messages; watch-list channels; redaction |
| C1-google | `src/connectors/{gmail,calendar,gemini-notes,drive}/**` | One builder for all mcp-adaptor sources, since they share the client. Gemini notes: attachment doc first, mail fallback, retries to 120 min, Transcript-only handling, shared assignees. **Drive: deck inventory plus forward edit sampling every 5 min, starting now** (history can't be recovered later) |
| C1-org62 | `src/connectors/org62/**` | Opp team memberships, **opp search**, my Events, DCs. If S2 slips, seed from the Now-kit CSV |
| C1-claude | `src/connectors/claude-sessions/**` | JSONL + desktop index + Cowork, incremental copy (outlives the 30-day cleanup), active-time calc |
| C1-ui-today | `src/app/(today)/**`, `src/ui/today/**` | Top 3, Now/Next/Later, meetings strip, deadline banner |
| C1-ui-triage | `src/app/(triage)/**`, `src/ui/triage/**` | Triage queue, accept/edit/dismiss, mapping questions |

**Wave 2 runs in order, since each step needs the one before.** The scheduler runs alongside:
1. C2-resolver: `src/engines/resolver/**`. Account/opp mapping from domains, title tokens, channel names and repo paths.
2. C2-commitments: `src/engines/commitments/core/**`. Asked-of-me, meeting next steps, team-pack system rules, **cross-source merge**, and done-detection v1 (reply-after-ask).
3. C2-priority-v1: `src/engines/priority/**`. Transparent scoring plus "why", with the DC/logging boost.
- C2-scheduler (parallel with 1–3): `src/worker/**`. Cadences, backoff, health, and the VDP/Org62 auth-lapse banner.

**Deferred out of P1:**
- VDP connector, Deals view → P3.
- `⌘K` search and learned rules → P5.
- The Outbox → P2.

**Verify:** from an empty DB on a normal workday, Today shows real Top 3 items. Each one links to its source. Replying in Slack closes the matching task within 10 min. A Gemini next step assigned to you appears within 30 min of its notes doc existing (the notes themselves can take up to about 77 min to show up). A promise mentioned in both Slack and Gemini notes shows up as **one** task with two sources.

---

## P2 / P3 / P4: three lanes in parallel

**P2 Time lane** (it also lands the Outbox core, since it's the first outbound lane):
- `src/core/outbox/**`
- `src/engines/time/**`
- `src/outbound/org62/**`
- `src/app/(time)/**`, `src/ui/time/**`, `src/app/(outbox)/**`, `src/ui/outbox/**`

Covers blocks, merge, allocation, the `WhatId` order (Opp → Account → DSR → Strategic Initiative → catch-all), Solutions Event drafts, links/CSV/Slackbot-prompt handoff, read-back verify, the QTD dashboard, and the Friday ritual. *Verify:* one real week is proposed, you approve it, the handoff happens, and the read-back marks it logged.

**P3 VDP lane:**
- `src/connectors/vdp/**`, `src/domains/vdp/**`, `src/outbound/vdp/**`
- `src/app/(deals)/**`, `src/ui/deals/**`
- An upstream PR in `~/Projects/vdp-app`, on its own branch, coordinated with the vdp-app owner. It adds asset tools, a readiness tool, and **`generate_use_case`** (AI use-case fields are UI-only today, and DC notes need a generated use case).

Covers the coverage checklist, use-case and stakeholder drafts from notes, decks and Slack, gated MCP writes, and UI handoffs for **Generate** and **AE/TA owner** until upstream tools exist. Also the deck finder leading to an asset handoff, and DC notes leading to the DC upload prompt. *Verify:* an opp with no VDP has a complete draft VDP and DC handoff ready in under 10 min of your time.

**P4 Composer lane:**
- `src/composer/**`
- `src/outbound/{slack,gmail}/**`
- `src/engines/voice/**`
- `src/engines/commitments/said-by-me/**` (a sibling of `core/`, not nested inside it)

Covers the TipTap editor with **Slack mrkdwn** round-trip (Gmail stays plain text plus drafts, since you rarely email), the voice profile, reply drafts, L2 drafts, L3 send, and promise extraction. *Verify:* you reply to a real DM from the app, the reply lands in Slack, and the task closes.

**Lane rules:**
- Lanes depend on the P1 contracts plus the Outbox core interface. P2 publishes that interface in its first chunk, before P3 and P4 write outbound code.
- Validators hit live sources one lane at a time, to respect VDP's 60 calls/min and the single devbar socket.

---

## P5–P7 (outline; detailed phase docs are written at kickoff)

- **P5 Planning:**
  - priority v2 (goal-aware, capacity);
  - Goals view, weekly plan, calendar-hold suggestions (via the Outbox);
  - morning brief and EOD wrap;
  - commitments ledger with on-time rate;
  - meeting prep briefs;
  - waiting-on-others plus nudge drafts;
  - retiring the Cowork 7am triage task.
- **P6 Deep signals:**
  - hooks and the `/cc` skill;
  - doc-edit sessions allocated to opps (from samples collected since P1);
  - git;
  - "start Claude session with context";
  - devbar `events.db` cross-check;
  - opt-in Drive Activity API and browser-tab sampling;
  - travel and Concur detection.
- **P7 Team:**
  - config extraction and the `team-packs/<team>`;
  - setup and doctor;
  - docs;
  - a pilot with one teammate.

---

## How the build runs (orchestrator + parallel sub-agents)

- **Orchestrator:** one long-lived Claude session on Opus in this repo. It owns `PLAN.md` and each phase doc's chunk ledger, dispatches builders, integrates, and talks to you. It reads only the builders' compact returns, never their logs: `{chunk, status, sha, files, verify, blockers}`.
- **Builders:** one per chunk, each in its own **git worktree** with a disjoint `files:` glob.
  - Sonnet by default; Opus for chunks marked `hard` (gate, time allocation, priority).
  - A tenet conflict is a stop-and-flag `blocker`, never a workaround.
- **Contracts first:** P0 freezes the contracts, and recorded redacted **fixtures** per source let the UI and engine lanes build before the connectors go live.
- **Integrator:** serial cherry-pick in the orchestrator, with the ledger checkbox flipped in the same commit. On conflict it stops and reports.
- **Reviewer:** one fresh-eyes Opus pass per wave, run on the *diff*, not the narrative. Hard tenet violations get fixed now; the rest become BACKLOG rows.
- **Validator:** drives the real UI against live read-only sources. Outbound actions stop at draft or dry-run, per *tenet: Draft, don't send*.
- **Your touchpoints per phase:**
  1. a go/no-go on the kickoff message;
  2. the acceptance pass;
  3. in between, only blockers that need you: OAuth/`/mcp`, cookie, real send clicks.
- **Expected width:**
  - P1: 6 parallel builders in wave 1, then a short ordered wave 2.
  - P2–P4: 3 lanes × 2–4 chunks each.
  - Overall, roughly 6–10 concurrent agents at peak.

## Open questions → see `DECISIONS.md`
