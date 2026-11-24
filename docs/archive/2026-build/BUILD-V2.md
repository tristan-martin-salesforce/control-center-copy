# Build v2: lanes, seams and rules (design v2 + integration)

**Status:** 2026-11-05. The orchestrator owns this file. It builds `docs/archive/2026-build/DESIGN-V2.md` into the real app and wires the frontend to the backend. Every v2 lane reads this file first; your own brief adds your scope.

## Read first (binding)
1. `CLAUDE.md`: the hard invariants. Never send or write to a real external system, read tools only, no secrets.
2. `docs/archive/2026-build/DESIGN-V2.md`: **all of it.** It's binding, and it beats UI-SPEC §1–2 and §16 on visuals. The capacity and estimates section is binding for engines.
3. `docs/archive/2026-build/UI-SPEC.md`: the **functional** spec (what each surface does, the save model in §8, feedback in §9, concurrency in §10, keyboard in §14). Keep the function; change the presentation.
4. `docs/reference/CONTRACT.md` and `src/contract/**`.
5. **The visual target: the mockups.** They're git-ignored and live in the main checkout; read the HTML and open them in a browser.
   - Files are in `~/Projects/control-center/public/mockups/`. View them at http://localhost:4327/mockups/index.html, which the user's dev server serves; never restart it.
   - **Home** = `home-1-briefing.html`, the owner's pick. Open states: `?panel=details&item=smoke|drafts|q4` and `?panel=assistant`.
   - **Assistant** = `home-1-chat.html` (the panel) and `chat.html` (the full page).
   - **Today** = `today.html`.
   - **Settings** = `settings.html`.
   - `index.html` has the color legend. `home-2-horizon.html` and `home-3-lanes.html` were not picked, but borrowing small ideas from them is fine.
   - `cc.css` holds the mockup tokens and components, a reference for the real `brand.css`.
6. Research, private and git-ignored, at `~/Projects/control-center/docs/research/`:
   - `14-visual-system-dark.md` (the token block, color roles, type scale);
   - `15-design-skills.md` §4 (the 50-rule review checklist; you self-review against it);
   - `13-comparable-apps.md` (patterns).

## What the owner decided (don't relitigate)
- **Home A** ("Morning paper") is the default route `/`: everything on one screen with **no page scroll** at 1920×1000 and 2560×1300. Today moves to `/today` and stays for day planning.
- **One docked right panel** is shared by item detail and the assistant, with Details and Assistant (⌘J) tabs. It pushes the content, and the page condenses into one consistent "with panel" layout that still doesn't scroll. Esc closes it.
- **Color is an indicator, never identity:**
  - blue = the one action, now, selection;
  - red = overdue, blocked or broken;
  - amber = at risk;
  - green = ready;
  - violet = AI.

  Accounts, people and sources are neutral. At most one color signal per row.
- **Dark first:** dark is the default theme; light must work too. 16 px base, nothing under 12 px, sentence case, no ALL-CAPS eyebrows.
- **Quiet actions, loud selection:** each row keeps its verb as quiet text. Only the selected or #1 item has the filled button, and an item open in the panel gives its filled button to the panel footer.
- **Capacity:** only today-scoped, hands-on minutes count. Agent time is a parallel background lane. Estimates are low and calibrated. No false "overbooked".
- **The product name is "Command Center"** in the UI. The code, folder and database rename comes later, in one pass, by the orchestrator. Don't rename identifiers.

## Seams (frozen APIs; build against them)
- **The right panel:** `useRightPanel()` and `registerDetailRenderer(kind, render)` from `@/components/shell`, defined in `src/components/shell/panel.tsx`.
  - Pages call `openDetails({kind, id, label})` on click or Enter, `openAssistant()`, and `close()`.
  - **Never build your own side sheet or overlay for detail.** Existing `SideSheet` usage gets routed into the panel by V2-SHELL.
  - `#cc-main` carries `data-panel="open|closed"` and is the `main` CSS container. Condense with `@container main (max-width: …)` queries, not viewport media queries.
  - Until V2-SHELL merges, the provider only holds state, so the panel doesn't render yet. Code against the API anyway.
- **Assistant tab content:** P-CHAT exports `<AssistantPanel/>` and `<AssistantPage/>` from `@/components/chat`. V2-SHELL mounts the existing `ChatTabPanel` until then; the orchestrator swaps the import at merge.
- **Detail renderer for `work_item`:** `<ItemDetail itemId variant="panel"/>` (V2-DETAIL adds the `panel` variant). V2-SHELL registers it.
- **Tokens:** V2-TOKENS keeps the existing token **names** (brief 14 §6.1) with new values. Anything you write uses names from `src/styles/brand.css`, with no raw hex. New names you'd want (e.g. `--color-on-accent`, `surface-raised`) come from brief 14 §6.2, and V2-TOKENS adds them.

## Lanes and ownership (stay inside your paths; anything else is a blocker to the orchestrator)
| Lane | Port | Owns |
|---|---|---|
| V2-TOKENS | 4345 | `src/styles/**`, `src/ui/**`, `app/globals.css`, `app/dev/kit/ui/**`, `scripts/contrast.mjs` (new), the `contrast` script line in package.json |
| V2-SHELL | 4346 | `src/components/shell/**` (implements `panel.tsx` behind the frozen API), `app/layout.tsx`, `app/dev/kit/shell/**` |
| V2-DOMAIN | 4347 | `src/components/domain/**`, `app/dev/kit/domain/**` |
| V2-DETAIL | 4353 | `src/components/detail/**`, `src/components/composer/**`, `app/work/[id]/**`, `app/initiatives/**` |
| P-HOME | 4348 | `src/components/home/**` (new), `app/page.tsx` (becomes Home), `app/today/page.tsx` (Today moves here), `src/contract/home.ts` (new) plus its export and route lines, `src/server/datasource/mock/home.ts` (new) plus its registration line, the generated `/home` route, `tests/home/**` |
| P-TODAY | 4349 | `src/components/today/**` |
| P-SETTINGS | 4350 | `src/components/settings/**`, `app/settings/**`, the display section of `src/contract/settings.ts` |
| P-CHAT | 4352 | `src/components/chat/**`, `app/assistant/**` (new) |
| CAPACITY | 4354 | `src/engines/priority/**`, the capacity block in `src/contract/views.ts` (additive), capacity code in `src/server/datasource/{mock,db}/**`, effort lines in `skills/nba-*.md`, `scripts/seed/**`, `tests/engines/**` |
| BE-CHAT | 4355 | `src/llm/chat/**` (new), `src/server/chat/**`, chat bits in `src/server/datasource/{mock,db}/**`, `src/contract/chat.ts` (additive), `tests/bechat/**` |
| BE-OUTBOX | none | `src/outbox/**` (new), outbox bits in `src/server/datasource/{mock,db}/**`, the sending section of `src/contract/settings.ts` (additive), `tests/beoutbox/**` |
| BE-READIN | 4356 | `src/llm/readin/**`, `src/jobs/handlers/readin.ts`, `skills/readin-*.md`, `src/contract/readin.ts` (new) plus one-line exports and routes, the read-in bits in `src/server/datasource/{mock,db}/**`, `src/components/readin/**` (the `ReadInSection`, which the orchestrator mounts in Details), `tests/readin/**`, one registry line, and migration `0008` only if unavoidable |
| BE-REEVAL | none | `src/jobs/handlers/reevaluate.ts` (new), `src/engines/reeval/**`, adapters in `src/engines/closure/**`, `src/server/datasource/db/closure.ts`, **one** wiring line in the worker/registry, `tests/bereeval/**` |

- **Port 4351** belongs to the scanner stress-test session (its own branch). Don't touch `src/scanner/**`, `src/connectors/**`, `skills/scan-*.md` or `scripts/stress/**`.
- **Shared files:** `src/contract/routes.ts`, `src/contract/index.ts` and the mock and db DataSource index files get **one-line, additive** edits only. Run `npm run gen:routes` after a route change and commit the generated file.

## Rules for every lane
- **Optimistic and undo.** Every mutation stays optimistic, with rollback, inline errors and 409 handling (UI-SPEC §10). Undo goes through `auditId`.
- **Keyboard and ⌘K.** Every action stays reachable by keyboard and in ⌘K (`useCommands`). j/k only moves the selection, Enter opens Details, Esc closes.
- **Panel states.** Every panel keeps its empty, loading, error and stale states (`PanelBoundary`, `Skeleton`, `StaleMark`).
- **Data:**
  - The mock auto-loads the private real seed (`~/Library/Application Support/control-center/fixtures/seed.json`). Use it for visual review.
  - Tests use `src/mock/seed.example.json`.
  - **Never commit real data or screenshots.** `.shots/` is git-ignored.
- **Dependencies:** no new npm dependencies without a blocker.
- **Install:**
  - UI lanes (those with a port) run `npm install` in their worktree.
  - Backend-only lanes symlink instead, to save disk: `ln -s ~/Projects/control-center/node_modules node_modules`.
  - At the end, `rm -rf .next`.
- **Test databases:** every `check` run uses your own suffix, `CC_TEST_DB_SUFFIX=<lane id, lowercase letters and digits only> npm run check`, so lanes never share a database.
- **Servers:** run `PORT=<your port> npm run dev:web`. Kill **only your own** server PID; never `pkill -f next`.
- **Merging:** the orchestrator merges foundation lanes (TOKENS, SHELL, DOMAIN, DETAIL) as they land and tells you. When told, run `git merge main` in your worktree, resolve, and re-verify.

## Verify (required before you return)
1. Run `CC_TEST_DB_SUFFIX=<lane> npm run check`. It must be green.
2. **UI lanes:**
   - Take screenshots at 1440×900, 1920×1000 and 2560×1300, plus light at 1920:
     - `npm run shot -- <route> --widths 1440,1920 --height 950 --port <port> --out .shots/<lane>`
     - `npm run shot -- <route> --widths 2560 --height 1300 --port <port> --out .shots/<lane>`
     - for light, add `--out .shots/<lane>/light`; the theme is set by your toggle or the URL your lane provides.
   - **Read every PNG** and compare it side by side with the matching mockup (screenshot the mockup too). Iterate at least twice.
   - Run a Playwright smoke test from your scratchpad: the key flows, one optimistic mutation plus undo, one forced error (`/api/v1/dev/fail`), and zero console errors.
   - Measure "no page scroll" wherever the mockup says it.
3. **Backend lanes:** unit plus integration tests on the real path. "Validated" means the real path ran to success with the visible result present (invariant 5).
4. Commit with conventional messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
5. Return `{lane, status: built|failed, branch, sha, files, verify, screenshots, blockers, notes}`.

## Wave 2 (2026-11-06): the other pages
On main now: V2-TOKENS, V2-DOMAIN, V2-DETAIL, P-HOME, P-TODAY, P-SETTINGS, P-CHAT, CAPACITY, BE-OUTBOX, BE-REEVAL, BE-READIN and BE-CHAT. V2-SHELL (the sidebar and the docked panel) is still landing. The orchestrator tells you when it's on main; then run `git merge main` and re-verify inside the real shell.

**These pages have no mockups.** Apply DESIGN-V2 the way the Home, Today and Settings mockups do:
- one focal point;
- verb-named sections capped at 3, or 5 at 2,400 px and up;
- a why line on every row;
- quiet actions with loud selection;
- color only as an indicator;
- width used as panes;
- 16 px base, sentence case.

Self-review against research 15 §4 (the 50-rule checklist) and say in your notes which rules you checked.

**Detail goes in the docked panel.** A click or Enter on a row calls `openDetails({kind, id, label})`. Delete the page's own side sheets: `ItemSheet`, `RunSheet`, `WatchesSheet` and the rest. Where a list and its detail would sit side by side at 1,600 px and up, the docked panel is that detail pane.

**Build on what's there:**
- `@/components/domain`: `WorkRow` (two lines by default; `dense` gives one), `NbaCard`, `SectionColumn`, `StatusBadge`, `AccountTag`, `EffortNote`, `itemIndicator()`, `CapacityMeter` and `AheadStrip`.
- `@/ui`: `RowVerb`, `TONE_BADGE`, `ListContainer variant="plain"`, `Tabs variant="line"` and `text-lead`.
- `@/components/readin`: `ReadInBadge` and `ReadInSection`.

| Lane | Port | Owns |
|---|---|---|
| P-LISTS | 4345 | `app/triage/**`, `app/work/page.tsx`, `app/work/_list/**`, `app/outbox/**`, `src/components/lists/**` |
| P-CONTEXT-A | 4347 | `app/deals/**`, `src/components/deals/**`, `app/briefs/**`, `src/components/briefs/**`, `app/time/**`, `src/components/time/**` |
| P-CONTEXT-B | 4348 | `app/agents/**`, `src/components/agents/**`, `app/health/**`, `src/components/health/**`, and new detail renderers for `calendar_event`, `connector` and `agent_run` in `src/components/panels/**` (new) |
