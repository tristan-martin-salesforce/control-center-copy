# 18 · UI polish pass (post-2.0, 2026-11-21)

Builder `post-ui-polish-pass`. Branch base `tmart2322/control-center-port-polish` at `55851bc`. Method: mock mode on lane
port 4385 (`CC_DATA=mock`, the committed placeholder seed, the mock clock rebased onto today, so the shots read
**Saturday 09:0x**). Every crawl route was shot at 1440 (and 1280 for Home, Today, Triage, Outbox, Activity, Deals, Settings), with
the Details panel open on Home, Today, the Home Needs-you queue, the Outbox, Activity and Deals; Settings sections; light
theme forced on Home and Deals ▸ DCs; `/onboarding` as the first-run state (there is no empty seed in `src/mock/`); and
the scenario clock's first minute on the Outbox with a row selected (seek 0 → 30 → 60 s). Each page was judged against
TENETS and UX.md the way Tristan meets it at 9 am: the right list first, plain words, why and next on every row, one
primary action, density at 1440 that keeps what matters, kit components, and nothing moving under the reader.

Shots are under `.shots/polish/` (before) and `.shots/after/` (after) in the worktree; `.shots/` is git-ignored.
Names are `<view>-<width>[-light].png`; `p-<page>` is the panel open; `live-outbox-<t>[a|b]` the scenario.

Severity: **H** a reader gets the wrong idea or cannot read it (overlap, a count that hides items, a raw error);
**M** jargon, a stale label, a clipped thing that matters, a layout that wastes the page; **L** cosmetic or already
planned elsewhere.

## Totals

| Severity | Found | Fixed here | Left |
|---|---|---|---|
| H | 5 | 5 | 0 |
| M | 23 | 19 (+3 in the leftovers pass) | 1 |
| L | 14 | 0 | 14 |

A row that says "see cross-cutting" repeats a shell finding on its page and is counted once. Rows marked – are notes, not findings.

## Cross-cutting (shell, every page)

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| The topbar's next-meeting chip lost the meeting at 1440 ("Next 09:30 1:1 … · in 27m") while the search field stayed 440 px wide. | M | **Fixed**: the search field gives way first (`flex-shrink` 8), the chip now reads "1:1 with P…" (Topbar.tsx). | home-1440 → after/home-1440 |
| A weekend morning reads as the end of a day: Home "Your day is wrapping up · Plan Monday" and Today "The working day is over" at 09:03 on a Saturday. | M | **Fixed**: Home says "Look ahead · Plan Monday →"; Today says "Outside your working hours. Monday: …" whenever the meter counts the next working day (true after hours and on a day off). | home-1440, today-1440 → after/home-1440, after/p-today-1440 |
| "LLM spend", "scanners go deterministic-only" in the spend tooltip, the spend popover, Health ▸ Spend / needs you, the ledger and Settings ▸ Budgets. | M | **Fixed**: "AI spend", "scans run on rules only (no AI) until tomorrow", "None (a plain read, no AI)". | set-budgets-1440 → after/set-budgets-1440 |
| The sidebar's Getting started card still counts the old 17-step checklist ("3/17") while `/getting-started` is five outcomes. | M | **Fixed (leftovers)**: the card, its popover and the page count the five outcomes ("1/5"; an AE has four); the steps are each outcome's detail (`OUTCOMES`, `outcomesOf` in `src/guide/checklist.ts`). | gs-1440 → leftovers/after/getting-started-1440 |
| Seven sidebar counts (27 · 20 · 9 · 3 · 2 · 1 · 7); Today's 20 is not something that needs you. | M | **Still open: Tristan's decision** (D-86, the sidebar's one count). The leftovers pass did not touch it. | home-1440 |
| At 1280 the rail shows a bare "14" badge (Getting started) and no counts but the Outbox dot (01 UI-9). | L | Left (guide + the planned sidebar). | home-1280 |
| Under load most pages sat on skeletons for 5–12 s and the dev server restarted twice ("approaching the used memory threshold"); not seen at rest. | L | Left: environment (shared machine, load guard paused the server for 10 min). | home-1440 (first run), account-1440 |
| The floating Dev pill covers the last action of a row or panel footer (01 UI-38). | L | Left: dev only. | p-homeneeds-1440 |

## Home

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| Respond said 11 but showed 3 chips; the other 2 chips the briefing sent were hidden by the one-line overflow and 6 more were never reachable from the line. A count above fewer items, with no way to the rest. | H | **Fixed**: the line measures what fits and says "+8 more" (shows every chip sent), then "+6 more on Work" (Work ▸ Asked of me). `respondMore` in Briefing.tsx. | home-1440 → after/home-1440 |
| Do now's head truncated at 1440: "Top 3 of 9 across every t…", "Closed 3 for you since yo…". | M | **Fixed**: "Top 3 of 9." and "✓ Closed 3 for you · Review" (the masthead already says since you left). | home-1440 → after/home-1440 |
| A card's prep steps were three clipped chips: "✓ Send A… ✓ Answer… ○ Kick off th…", on card 2 "✓ Se… ✓ An… ○…". | M | **Fixed**: one line, "Demo prep · 2/3 done · ○ Next: Kick off the demo-org build", every step in the tooltip (`prepSummary`). | home-1440 → after/home-1440 |
| With the panel open the cards' account tags ("ACME", "Outbox") collapsed into empty boxes (01 UI-12). | M | **Fixed**: a short tag never shrinks; a long one still truncates (AccountTag, domain/lib/v2.tsx). | p-homeneeds-1440 → after/p-home-1440 |
| With the panel open Home does not reflow: the ribbon reads "0… 0…", the closed line "Clo…" (01 UI-12, R11). | M | **Fixed (leftovers)**: under 900 px of content Home is one column (home.css, width-only): the Do now head wraps, card 1 takes the row and 2–3 share the next, the verb columns stack (Chase too), a meeting too narrow for a word shows its colour only, the page scrolls instead of clipping. | leftovers/before/p-home-1440 → leftovers/after/p-home-1440, p-home-1440-scrolled |
| The masthead says "Today turns on the 13:00 ACME demo" while the meter counts Monday (the mock rebases the seed onto a Saturday). | L | Left: mock data. | home-1440 |

## Today (and Home ▸ Plan)

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| With the panel open the run of the day's meta line ran under the verbs: "ACME Open in Claude", "Globex · you ~15nSend", "ACMShooze yDone5m". | H | **Fixed**: the meta line is capped to its column (`max-width: 100%` beside `justify-self: start`, today.css) and truncates. | p-today-1440 → after/p-today-1440 |
| "The working day is over" at 09:03 on a Saturday. | M | **Fixed** (see cross-cutting). | today-1440, today-1280 |
| A third rail ("Agent's plan 4") beside the day column and the run of the day (01 UI-14). | L | Left: Today folds into Home ▸ Plan (D-86). | today-1440 |

## Triage

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| Clean: one sentence, the keys, verb-named groups, the source on the why line, Sure/Likely/Guess in words. Looks done and missed opps also live elsewhere (01 UI-15). | L | Left (Triage folds into Needs you after the queue, D-86). | triage-1440, triage-1280 |

## Outbox

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| A failed draft showed the raw error: "Gmail API 503: backendError". | H | **Fixed**: `plainFailure` says "Gmail had a temporary problem on its side. Retry sends it again." (sign-in, too-many-requests and unknown codes too); the raw text stays in the row's details. | outbox-1440 → after/outbox-1440 |
| "Approve: push draft" (01 UI-16). | M | **Fixed**: "Approve: draft in Slack" / "Approve: draft in Gmail". | outbox-1440 → after/outbox-1440 |
| The draft panel's filled button "Push as draft", the confirm "Push draft" / "Push a Slack draft for …?", the results "Pushed as Slack draft", "Draft pushed", "✓ Pushed as draft". | M | **Fixed**: "Save as Slack draft", "Save draft", "Save a Slack draft for …?", "Saved as Slack draft", "Draft saved". | live-outbox-30a → after/p-today-1440 (same composer) |
| Scenario: a new draft lands above the selected one and the selection slides down a row (UX.md says it lands above); the mock's scenario draft duplicates "Gmail · reply · to Marcus". | L | Left: spec'd behaviour; mock data. | live-outbox-0, live-outbox-30a, live-outbox-60b |

## Work and the work item

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| Work's first section was "Do now 9", the words Home uses for its top 3 (01 UI-17, R3). | M | **Fixed**: "Due today 9", sentence "9 due today, 25 open in all…". | work-1440 → after/work-1440 |
| The VDP re-auth banner repeats on Work (01 UI-2). | L | Left (R7: one surface for connection errors). | work-1440 |
| The work item page: strong (why it's first, next step, plan, context pack). | – | – | workitem-1440 |

## Deals, Missed opportunities, DCs, account

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| Deals ▸ DCs: an empty "Requests 0" pane took half the page and squeezed Your DCs to "… · rea…" (01 UI-20). | M | **Fixed**: no requests is one quiet line ("No DC requests in flight. Claim one from …"), Your DCs gets the width. | dcs-1440 → after/dcs-1440 |
| "logging canvas" / "On a canvas" / a "Canvas" button on DCs, Missed, the claim dialog, the opp panel, Triage's claim toast and the account's DC words. | M | **Fixed**: "your next batch", "In a batch", "Open in Slack" (Activity's rule, now everywhere). | dcs-1440, missed-1440 → after/dcs-1440 |
| The account crumb was "Deals › Financial Services" (the industry, not a level of Deals; 01 UI-21). | M | **Fixed**: "Deals › Globex · Financial Services". | account-1440 → after/account-1440 |
| The account sentence: "1 opp the missed-opp sweep says is yours and no DC". | M | **Fixed**: "1 opp that looks like yours and no DC" (`src/engines/deals/needs.ts`, one string). | account-1440 → after/account-1440 |
| Deals ▸ Log & fix and Accounts rows truncate their why at 1440 ("1 opp you're o…", "DC parti…"). | L | Left. | deals-1440 |

## Agents and Tools

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| "Open in Claude" overlapped "14h ago" in the next column: the need line never shrank (01 UI-23). | H | **Fixed**: the need line truncates in its column (title holds it whole). | agents-1440 → after/agents-1440 |
| The tab said "Runs 1" above "Running now 3" (it counted runs waiting on you; 01 UI-3). | M | **Fixed**: no count on the tab; "All waiting · 1" and the sidebar carry it. | agents-1440 → after/agents-1440 |
| Tools: clear. | – | – | tools-1440 |

## Activity

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| "Needs you here" sits above the page's sentence, toggle and tabs, outside the page's scroll: ~330 px fixed at the top of To log, so at 900 px tall the list itself starts below the fold. | M | **Fixed (leftovers)**: it is the first section under the tabs, inside the view's scroll (`ActivityNeedsSlot`, ActivityHead.tsx), on To log's list and week; same rows, same keys (a / s / x / z, Review N). | leftovers/before/activity-1440 → leftovers/after/activity-1440 |
| A Needs-you "Claim: Globex · Renewal FY27" row opens Triage on click (the row has no entity). | L | Left (queue data). | p-activity-1440 |
| To log, Week, Review, History and VDP read in plain words (the deny-list test holds). | – | – | act-*-1440 |

## Health

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| "Ranking: priority@2 in shadow · no runs yet", "Resolution check (shadow): …". | M | **Fixed**: "Ranking: the new ranking, previewed beside your list", "Resolution check (watch only)", "agrees on 67% of the Top 3" (`healthPlain`). | health-1440 → after/health-1440 |
| One action, two names: "Run refresh" on the banner and Sources, "Re-auth VDP" on Setup. | M | **Fixed**: a refresh script's button reads its own label (the catalog's "Re-auth VDP") everywhere; Settings' help says the same. | health-1440 → after/health-1440 |
| Org62's rate limit offers "Rescan" (a tempting wrong click; 01 UI-31). | L | Left. | health-1440 |

## Settings

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| From 1,180 px the grid had a third, empty 380 px column while the effect pane was still hidden (it shows from 1,360): the form was ~550 px at 1440, Connectors' actions clipped to "S", Autonomy's ladder to "A" (01 UI-32). | H | **Fixed**: 1,180–1,359 px is two columns (settings.module.css); the form takes the width. | set-connectors-1440, set-agent-1440 → after/set-connectors-1440, after/set-agent-1440 |
| Autonomy: "Approved canvas rewrite", "the two approved canvases only". | M | **Fixed**: "Updating an approved batch", "the two approved batches (logging and forecast)". | set-agent-1440 → after/set-agent-1440 |
| Budgets: "Daily LLM spend … scanners go deterministic-only". | M | **Fixed** (see cross-cutting). | set-budgets-1440 |
| Profile: "The role pack sets your starter policy; … shape the day spine". | L | Left. | set-profile-1440 |

## Getting started and onboarding

| What is wrong | Sev | Status | Shots |
|---|---|---|---|
| "1 of 4 done. Five things and Command Center runs your day…" read as a miscount. | M | **Fixed**: the sentence names the role's count: "1 of 4 done. Four things and Command Center runs your day. Each one ticks itself from what you actually did." (`src/components/onboarding/started-sentence.ts`; quote corrected 2026-11-21, 23-docs-coherence finding 9) | gs-1440 → after/gs-1440 |
| Step 4 said "On Time, approve a week of activity rows, stage them as one logging canvas and Apply it." | M | **Fixed**: "On Activity, review a week of rows, log them as one batch and Apply it." (`src/guide/checklist.ts`, one string). | gs-1440 → after/gs-1440 |
| Onboarding (first run): clear six steps with the preview rail. | – | – | onboarding-1440 |

## Other pages

| Page | What is wrong | Sev | Status | Shots |
|---|---|---|---|---|
| Assistant | Suggested prompts are generic ("/rescan slack 2d"; 01 UI-11). | L | Left. | assistant-1440 |
| Briefs | Clean master–detail. | – | – | briefs-1440 |
| History | Calendar cells truncate hours ("4.2…"; 01 UI-30). | L | Left. | history-1440 |
| Light theme | Home and Deals ▸ DCs readable with `data-theme="light"`; the contrast suite guards the tokens. | – | – | home-1440-light, dcs-1440-light |

## Leftovers pass (post-ui-leftovers, 2026-11-21)

Builder `post-ui-leftovers`, lane port 4394, shots under `.shots/leftovers/{before,after}/`. Three of the four M items
above are fixed; the sidebar count (D-86) stays open for Tristan. One more change rode along:

| What | Status | Shots |
|---|---|---|
| Work ▸ Closed read every closed item at once. | **Done**: the tab sends `limit` 50 and draws "Show 50 more · N of M shown" under the list; the button reads the next page by `nextCursor`, appends it and seeds the window's query, so live refetches read the whole window (`limit` = pages × 50) through the same live-list merge. Counts stay the payload's. Open tabs unchanged. | leftovers/after/work-closed-1440, work-closed-more-1440 (shot with the page size rewritten to 2: the mock has 6 closed) |

Tests: `tests/ui/home-narrow.test.ts`, `src/components/time/__tests__/activity-needs.dom.test.ts`,
`tests/lists/work-paging.test.ts`, `src/guide/__tests__/getting-started.dom.test.ts` (outcomes, the page's count, the DC
confirm), `tests/handoff/guide.test.ts` (the five outcomes; every step in exactly one), `tests/onboarding/started-sentence.test.ts`.

## Tests added or updated

- `src/components/home/__tests__/briefing-polish.dom.test.ts`: "+N more" (and where it goes), the short lead, the prep line.
- `src/components/home/__tests__/plan-day.test.ts`: the nudge and lead wording.
- `tests/today/day-header.dom.test.ts`: "Outside your working hours".
- `tests/agents/runs-polish.dom.test.ts`: no Runs count; the need line truncates.
- `tests/ui/deals-plain-words.test.ts`: DCs, Missed and the account page against the mock DataSource: no canvas / sweep words, the one-line empty requests, the crumb.
- `tests/health/plain.test.ts`, `tests/settings/grid-columns.test.ts`, `tests/onboarding/started-sentence.test.ts`.
- `tests/lists/triage-outbox-briefs.test.ts`: the draft-mode labels, the confirm words, `plainFailure`; `src/components/lists/lists.test.ts` (Due today); `src/components/panels/__tests__/derive.test.ts` (the re-auth label); `src/components/detail/__tests__/panel.test.ts`; `tests/handoff/guide.test.ts` (the step's words).

UX.md gains one bullet under "Pages on the kit": plain words on every page (the rule applied here).
