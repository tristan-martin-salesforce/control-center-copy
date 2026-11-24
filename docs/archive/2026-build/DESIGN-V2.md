# Design v2: calmer, bigger, dark-first (direction for mockups and the rebuild)

**Status:** draft, 2026-11-05. The orchestrator owns it. It replaces the visual parts of UI-SPEC §1–§2 and §16 once Tristan picks a mockup direction. The research behind it is in the private briefs 13–16 in `docs/research/`.

## Why
Tristan's review of the mock:
1. **Too dense.** Too much goes on at once, the text is small, and the screen is used poorly.
2. **Too literal about Salesforce.** He wants Salesforce colors and fonts, not the look of the Lightning platform.
3. **Too little color.** He wants several colors, and dark mode is his main mode.
4. **No single home.** One page should hold the most important things across every tab and every day. Today is only the day-planning view.

Information density should stay; it just needs better display.

## Principles (each one is checkable on a screenshot)
1. **One focal point per screen.** Blur the screenshot and the eye still lands on it.
2. **Focus-order sections that disappear when empty**, each capped at 3, or 5 at 2,400 px and wider, with "See all N →" for the rest.
3. **Verb-named sections:** Do now, Reply and approve, Prep, Log and fix, Chase, Think ahead. Tabs stay nouns.
4. **Quiet actions, loud selection.** Every row keeps its own action verb, drawn as quiet text. Only the selected row, or the #1 item, gets the filled button. Batch actions go in the section header. Snooze, done and not now appear on hover or selection and in ⌘K.
5. **A why line on every row**, as one muted line. The evidence lives in the detail pane.
6. **Width becomes panes, not gutters.** No centered column with empty side bands over 15% of the screen. At 1,600 px and wider, list and detail sit side by side. At 2,400 px and wider, a third pane appears. Prose stays at most 68ch.
7. **Bigger type:** a 16 px base. Home row titles are 18–20 px, page titles 28 px. Nothing is under 12 px. Sentence case, with no ALL-CAPS eyebrows.
8. **Color is an indicator, never identity.** Tristan, 2026-11-05: "Different colors for everything is frankly a little confusing… colors [should] be visual indicators."
   - **Blue:** the one action to take, what's happening now, focus and selection.
   - **Red:** overdue, blocked or broken. **Amber:** at risk or prep missing. **Green:** ready or done. These are always paired with an icon or word.
   - **Violet:** AI drafted or proposed it.
   - Accounts, initiatives, people and sources are neutral text or tags with no per-account hues. A quiet screen means nothing needs you.
   - At most one color signal per row.
9. **Dark first.** Navy-tinted near-black surfaces in 4 elevation steps: `#0e141e` / `#161d28` / `#1f2733` / `#28313f`. Hairline borders, no glow. Every text pair is AA or better.
10. **Calm chrome.**
    - A dimmed left sidebar replaces the Lightning header, nav bar and utility bar.
    - **One docked right panel, shared by item detail and the assistant,** with Details and Assistant (⌘J) tabs.
      - Clicking or pressing Enter on any card or row opens Details. ⌘J opens Assistant, which knows the selected item.
      - The panel pushes the content, so the page condenses into one consistent "with panel" layout that never page-scrolls.
      - Esc closes it. At 2,560 px the panel is simply another column.
    - System status shows up only when something is broken.
11. **A day that ends.** Home closes with "That's everything" and one status line. No infinite scroll.

## Information architecture
- **Home (new, the default route):** the most important things across every tab and every day.
  - Do now (≤ 3);
  - Reply and approve (Outbox);
  - Think ahead (a 14-day horizon with prep readiness);
  - Log and fix (missing internal things: Org62 events, the Q4 log, DC requests, VDP, expenses);
  - Chase (waiting on others, promises going stale);
  - Initiatives at a glance;
  - briefs worth a look, as one line.
- **Today:** planning the day (spine, fit-ins, capacity). Kept and simplified.
- **The other pages stay** (Triage, Work, Briefs, Deals, Agents, Time, Outbox, Settings). Each gets the same type, color and pane treatment.
- **Settings:** three panes: section nav, one selected section with label-left rows, and a preview of what the setting changes.

## Capacity and estimates (engine fix, binding for the rebuild)
Tristan, 2026-11-05: "You way overestimate how long things take… don't take into account that I can have things working in the background… You said 10 hours overbooked today but that wasn't true at all. E.g. activity logging… can be tomorrow."

- **Count only today-scoped work:** due today, start-by today, or pinned to today. Everything else is "pull forward if you have time", never load. (`src/engines/priority/plan.ts`'s `plannedMin` currently sums all open work.)
- **Count only hands-on time.** Agent and Claude-session time runs in the background, in parallel. Show it as its own lane or marker, never against capacity. (`agentMinQueued` is separate already; keep it out of `overByMin`.)
- **Estimate low and learn.**
  - Default you-minutes by kind: reply or post 5–15, approve 2–5, review 10–20, re-auth 2. A build is kickoff plus review, not the build's duration.
  - Calibrate from actuals: completion timestamps, Time data and one-click corrections ("took 10m").
  - Scanner and NBA skills estimate hands-on time only.
- **Say "overbooked" only when it's true:** when today-scoped hands-on time is greater than free time outside meetings. Otherwise show "Fits · ~Nh open".

## Brand
- **Keep:** Salesforce Sans, the Salesforce blue and cloud palette, the 2026 circle "atmosphere" glow (≤ 12% alpha, top of the canvas only) and the agentic gradient for AI.
- **Drop:** the Lightning global header, nav bar and utility bar; the gray canvas; pill buttons; 3 px tab underlines; object tiles everywhere; and the 13 px base size.

## Rename
The product becomes **Command Center** (the "cc" shorthand stays). The code, folder, data folder and database are renamed in one pass once no other sessions are running.
