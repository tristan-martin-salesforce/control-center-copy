# Holistic review, 2026-11-20: shared brief for every reviewer

You are one of eleven specialist reviewers. An orchestrator reads only your report file; be precise and evidence-based.

## The app
Control Center: a locally run personal-ops cockpit for Salesforce sellers (SEs, Specialist AEs). Read `CLAUDE.md`, `docs/TENETS.md`, `docs/ARCHITECTURE.md` (partly stale: it says SQLite, the app runs Postgres), `docs/DECISIONS.md` (D-1..D-75, very dense: the sprawl is itself a finding), `docs/PLAN.md`, `docs/UX.md`, `docs/BACKLOG.md`, `docs/reviews/2026-11-13-app-audit.md` (the last audit: caps, cost table, lanes A-E), `README.md`. `docs/ui/*` are build-time specs. `sample-data/` is a synthetic copy of the real DB (120 tables, CAST docs explain the scenarios); read its JSON for realistic data shapes. ~226k lines of TS in `src/` + `app/`.

## The owner's verdict (Tristan, 2026-11-20), paraphrased closely
"The app has the features I want. It just needs to be usable, easy for other people to pick up, and extensible." Goal: "I can organize my day, prioritize, do admin tasks efficiently. I should know what's important for me to do and it should be the right list. If we get this right I (a) never lose track of things to do, people to respond to, when to start builds; (b) spend almost no time on admin. If not, it's one more channel of noise." Ported to a personal machine because work restricted tokens. He expects "this review and the decisions out of it will likely touch most, if not all code." Data model changes need a migration path (people already run it). Future: a packaged app with updates; feedback comes back via the publish-to-Slack feature; must work out of the box for non-technical teammates with really good end-to-end error handling (how each MCP connection breaks and what the next step is; missing devbar explained; no standing up a custom DB). Salesforce compliance: local app, MCP connections and `claude -p` sessions only.

His asks, numbered as he gave them:
1. UI isn't great (e.g. drafts on Home as a long list). Dig in: what else? What does a great UI look like? What have others done?
2. Scanners and item resolution: better than before but still misses things, and items don't auto-close as expected.
3. Token spend ~$10/day for scanning; should be very cheap. Likely lower-tier models, which needs a very concise tool set and instructions so the agent needn't be smart. Fill the agent's context intelligently (esp. the resolution agent: how does it quickly check if an item is done, do additional read-ins). The first/original scan is also expensive.
4. Assistant isn't useful enough; hits limitations constantly. It should be able to do anything (traverse the data model, scan connected systems) but via efficient paths with guardrails (approvals) and more efficient than raw Claude. Haiku option. Remove arbitrary limits (e.g. GDrive read char limits). "A purpose-built Claude with efficient paths and guardrails on edits."
5. Spend caps limit more than help. Instead: estimate up front and warn if it will exceed; during execution raise a hand when spend climbs and ask to continue without killing the session.
6. Time logging still sucks. It should guess opp + account automatically; when looped into a new deal, scan Org62 for best matches; deal-contribution suggestions arrive automatically (possibly several opps per time entry); toggleable setting "AEs I cover" to suggest claiming DCs on their deals; use cases into Org62 + VDP seamlessly (from team, meeting transcripts; Granola later). "I really don't want to have to think about this"; when unsure give a rundown of the opportunities so he can add quickly.
7. Connectors easy to add; LLM provider pluggable (someone may use OpenAI).
8. Data model: modeled correctly? Org62 vs VDP data sensible? Consolidate in UI? Multiple data model types? Is a structured DB right for everything? Agents scanning the DB vs RAG for token efficiency?
9. Limits/structure: contributing docs, AGENTS.md, light lint (e.g. file length). Don't slow building; evergiftapp-style density is too much for a local app.
10. Testing: isolate modules so a change doesn't run the whole suite; a concise build strategy (he'll build on the work machine too).
11. Refactor for maintainability as we change things; extensible without overengineering.
12. Packaged app in future; versions drift today; Slack feedback is the bug intake; updates.

## Rules for every reviewer
- Read-only. Do not edit anything under `src/`, `app/`, `tests/`, `scripts/`, or docs other than your own report file. Do not commit.
- Never call external systems (Slack, Gmail, Org62, VDP, Drive, Calendar) or any MCP. There is no Postgres on this machine; `node_modules` is installed. Mock mode runs: `CC_DATA=mock PORT=<your port> npm run dev:web` (ports 4345-4352 assigned per reviewer), `npm run shot -- <route> --port <port>` writes `.shots/`. `npm run typecheck`, `npm run lint`, `npm run test` (unit, mock seed) are allowed.
- Never print or copy credentials. The repo and sample data contain only placeholders; keep it that way in your report.
- Cite tenets by name (e.g. *tenet: Nothing leaves without approval*). Flag any recommendation that conflicts with one as a blocker needing Tristan.
- Evidence: cite `path:line` for every claim about the code. Say when you did not verify something.
- Web research is allowed and encouraged where your brief says so (WebSearch via ToolSearch, or the web-fetch agent).

## Report format (write to your assigned file; ≤ 500 lines; prose + tables, no fluff)
1. **Summary** (10 lines): the 3-5 things that matter most.
2. **How it works today** (short, with file pointers): so the orchestrator and the next builder don't have to rediscover it.
3. **Findings**: numbered `<LANE>-n`, each with severity (blocker/major/minor), evidence (`path:line`), why it matters to the owner's goal.
4. **Recommendations**: numbered, prioritized, each with effort (S: <1 day, M: 1-3 days, L: >3 days of one agent), dependencies on other lanes, and the migration/compat path where data or contracts change.
5. **Decisions for Tristan**: options + your recommendation, only where a choice really changes the work.
6. **What's fine, don't touch.**
7. **Open questions / what you could not verify.**
