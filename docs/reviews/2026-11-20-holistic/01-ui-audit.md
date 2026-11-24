# 01 · UI-AUDIT: holistic review 2026-11-20

Reviewer lane: UI-AUDIT (owner asks #1, plus the UI side of #4, #6, #8 and #12). Method: mock mode on :4345
(`CC_DATA=mock`), 60+ screenshots at 1440 (plus a few at 1280 and 2600 tall), Playwright clicks for panels and
overlays, then a code read of `src/components`, `app/*/_*`, `src/engines/home`, `src/guide`, `src/ui`.
Screenshot names below refer to the run's scratch folder, not the repo. Each one is `<route-slug>-1440.png` under a
folder named for the view (e.g. `act-needs/activity-1440.png`). They can be recreated with
`npm run shot -- <route> --port 4345 --widths 1440`.

## 1. Summary

1. **There are too many places to look, not too many items in one place.** Home's engine caps every list (3 cards, 3 rows a column; `src/engines/home/build.ts:70`), so Home itself is fairly calm. The noise comes from the app around it: **11 sidebar destinations, 6 live counts summing to ~42** (`src/components/shell/nav.ts:38-58`), **Home and Today both answer "what now"**, and the same need shows on 3–7 surfaces. VDP re-auth alone shows in 7 places (sidebar status, Home ▸ Log & fix, Work banner, Health, Settings ▸ Connectors, Activity ▸ VDP banner, Getting started). *Tenet: Calm, not a firehose* is met on Home and broken across the app.
2. **Drafts are spread across Home, not listed once.** A draft shows as the Outbox card (#2 Do now), as its own Do-now card ("Reply to Dana · Draft ready · Send"), as "Send draft" rows in Reply & approve, and as "Review draft" verbs (`build.ts:638-640`, `:706-722`, `:1344`, `:1422`). With real volumes (dozens of drafts) this is the "long list" the owner sees. Approval belongs in **one** queue, the Outbox, and Home should show only a count and a "Review N" entry point.
3. **Activity is the hardest page, and it's the one the owner most wants to stop thinking about (#6).** It has 2 system tabs × 5–6 sub-tabs (Log it · Needs you · Weeks · Ledger · Use cases · Forecast; Changes · My VDPs), counts that don't add up (sidebar 7, Org62 1, VDP 6, Log it 1 with 2 ready rows), a topbar title that changes between Activity, Time and VDP, and internal words on screen (canvas, Slackbot, read-back, CF/CR, `Use_Case__c`, "(D-63)").
4. **There's no shared model for a row or for actions.** I found 45 bespoke `*Row` components (`grep "function \w+Row"`), three styling systems (Tailwind utilities, CSS modules with 1,742 lines in settings alone, and prefixed global CSS like `hm-*` and `today.css`), and five near-synonym item verbs (Done, Resolve, Snooze, Not now, plus Accept or Dismiss in Triage; `src/components/detail/lib/mutations.ts:36-47`). A teammate can't extend this without copying a page.
5. **A non-technical teammate gets stuck in the first hour (#12).** Re-auth is "copy this `python3 ~/.claude/scripts/…` command" (Health, Settings ▸ Connectors), Getting started is a 17-step checklist that's mostly "Tour X", raw errors leak through (`SyntaxError: Unexpected token '<'`, `src/client/api.ts:112`), and the sidebar says "Command Center" while the docs and repo say "Control Center".

## 2. How it works today (pointers for the next builder)

- **Shell.** `app/(app)/layout.tsx` hosts a client router (`app/(app)/ClientRouter.tsx:41-91`, route table in `src/components/shell/routes.ts:45-66`). The sidebar groups are `NAV_GROUPS` (`src/components/shell/nav.ts:38-58`), each with a `g` chord and an optional count key. Health and Settings sit pinned in the sidebar footer. The topbar holds the page title, a `?` page help, "Search or ask… ⌘K", the next meeting, Capture, Feedback and Assistant ⌘J (`src/components/shell/Topbar.tsx`, `UtilityBar.tsx`). The docked right panel has two tabs, Details and Assistant (`src/components/shell/RightPanel.tsx`, width 520/600, `nav.ts:96-104`).
- **Pages (17 route keys).** home, today, triage, outbox, assistant, work, workItem, deals, missed, dcs, account, briefs, agents, tools, time (`/activity`, `/time`), health, settings, history, initiative. Four pages live under `app/*/_*` (Triage, Outbox, Work, Briefs: `app/triage/_triage/TriagePage.tsx` and others). The rest live in `src/components/<page>`. That split is itself an inconsistency.
- **Home** is server-composed. `src/engines/home/build.ts` (1,500 lines) builds the masthead sentence, day ribbon, capacity, Do now (≤3), the Looks done strip, the verb columns (Reply & approve · Think ahead · Log & fix · Chase, and Initiatives when wide), and the footer. The client renders it with `src/components/home/*` (1.5k lines) and the shared `SectionColumn` (`src/components/domain/SectionColumn.tsx`).
- **Activity** (`src/components/time/`, 51 files, 11.5k lines, the largest folder) switches on `?view=` (`TimePage.tsx:136-173`): week (Log it), needs, weeks, log (Ledger), usecases, forecast, vdp (`&sub=mine`). Persona gating goes through `GatedView` (`TimePage.tsx:180`).
- **Settings** has 15 sections in 6 groups (`src/components/settings/derive.ts:161-205`), shown as section nav, a form and an "effects" rail (`settings/effects.tsx`, 625 lines).
- **Lists.** The shared live-list machinery is good (`src/components/lists/live-list.ts`, `live-merge.ts`, `stable-order.ts`; `docs/UX.md` "Live updates"). It's used by Triage, Outbox, Work and Activity rows, but each page renders its own row component.
- **Guide.** `src/guide/*`: checklist (`checklist.ts`), per-page tours (`pages.ts:289-316`), coach marks, and page help behind the topbar `?` (`PageHelp.tsx`).
- **Assistant.** `src/components/chat/*` (31 files, 4.9k lines). It's a page (`/assistant`) and a panel (⌘J), with proposal, receipt, resource and scan cards (`ChatProposalCard.tsx`, `ChatReceiptCard.tsx`, `ChatActionCards.tsx`). The dev harness is at `/assistant?embed=panel&fixture=1` (`app/assistant/_preview/AssistantPreview.tsx`).

**IA as it is**

```
Sidebar (11 + 2 footer)                     Counts      Tabs / sub-views inside
─ Home                                       –          Today|Monday toggle; ribbon; Do now(3); Looks done; 4–5 verb columns
─ Today                                      20         Day timeline | Run of day | Agent's plan rail
─ Triage                                     9          Looks done · Asks & promises · Takeaways · Mapping Qs · Missed opps · Closed for you
─ Outbox                                     3 (red)    Approve · Retry · Going out later · Sent
─ Assistant                                  n staged   Threads | thread
Context
─ Work                                       –          All open · Said by me · Asked of me · Promises · Trainings · Snoozed · Done × By when|By initiative
─ Deals                                      –          Accounts · Missed opportunities · DCs ; /deals/:account (Brief · Initiatives · Assets · Sessions · Notes)
─ Briefs                                     2          Watched · My opportunities · Watches
─ Agents                                     1          Runs · Tools
─ Activity                                   7          Org62 {Log it · Needs you · Weeks · Ledger · Use cases · Forecast*} · VDP {Changes · My VDPs}
─ History                                    –          calendar + day
Footer: Getting started 3/17 · Settings (15 sections) · status lines (re-auth, catching up, $ spent) · version
Hidden: Health (g s; reached from status lines and banners) · /initiatives/:id · /work/:id
Right panel: Details | Assistant      Topbar: ? · ⌘K palette · next meeting · Capture · Feedback · Assistant
```

That makes roughly 40 distinct tab or sub-view states before you count panels.

## 3. Findings

### Cross-cutting

**UI-1 (major): Two "what now" pages.** Home (`/`) and Today (`/today`, count 20) both rank today's work with a day timeline (`home-1440.png` vs `today/today-1440.png`). Home's Do now and Today's Run of day give different orders and different counts ("Top 3 of 9" vs "7 to do, in order"). Work also has a section called "Do now" holding 9 items (`work/work-1440.png`), so the same label names a top 3 on Home and a list of 9 on Work. *Tenet: Legible* suffers because "why is this #1" has two answers. Code: `src/components/today/*` (21 files, 4.6k lines) on top of `src/components/home/*`.

**UI-2 (major): Need surfaces are duplicated.**

| Need | Where it appears |
|---|---|
| Looks done: confirm | Home strip (`home/LooksDone.tsx`), Triage group (`app/triage/_triage/TriageRows.tsx:224`), Work group (`domain/WorkRow.tsx`) |
| DC gaps / Claim DC | Home ▸ Log & fix, Deals ▸ Log & fix, Deals ▸ Missed, Triage ▸ possible missed opps, Account page (D-68; `deals/needs.ts`, `deals/ClaimDc.tsx`) |
| VDP re-auth | 7 places (see Summary 1) |
| Unlogged time | Home ▸ Log & fix ("Q4 activity log: Confirm 4"), Activity ▸ Log it, Activity ▸ Needs you, Activity ▸ Weeks, Ledger "Waiting on you" |
| Drafts | Home ×3 (UI-4), Today ("Send"), Work rows, Outbox, Agents |

Each surface has its own component, copy and counts, so they drift (UI-3). The owner's goal "never lose track" is better served by one queue that's always right than by five partial ones.

**UI-3 (major): Counts don't reconcile.**
- Home "Reply & approve **9**" with "See all **5** asks" (`build.ts:1422`: the section count is `reply.length`, the link counts only `kind==='ask'`).
- Activity: sidebar **7**, Org62 tab **1**, VDP **6**, Log it **1** while "2 rows ready", Needs you **7** while the header says "6 rows need you" (`act-week/activity-1440.png`, `act-needs`).
- VDP: "Changes **6**" vs "**17** changes the app can push" vs "1 VDP needs you · 5 not in VDP yet" (`act-vdp`).
- Account page: "Worth a closer look **0**" above one listed item (`account/deals-acc-acme-1440.png`).
- Agents: tab "Runs **1**" above "Running now **3**" (`agents`).

Each one is defensible on its own, but together they read as untrustworthy (*tenet: Trustworthy*). The last audit flagged the same class of bug as C2 (`docs/reviews/2026-11-13-app-audit.md:82`).

**UI-4 (major): Drafts on Home.** A ready draft can appear as (a) one of up to 3 lines in the Outbox card (`build.ts:706-722`, `DoNow.tsx:123-152`), (b) its parent item's Do-now card with "Draft ready · Send" (`build.ts:640`), (c) a Reply & approve row with "Send draft" / "Review draft" (`build.ts:638-640`), and (d) a Chase row with "Nudge" pointing at the draft (`build.ts:939`). The engine's "nothing listed twice" (`build.ts:14`) holds for *items*, not for *drafts*: one draft, three verbs (Send, Review, Approve). In mock, the Outbox card lists "Marcus · Re: DPA redlines" twice after the scenario runs (`hometall/today-1440.png`). Clicking "Review 2" leaves Home for `/outbox` (`inter/home-draftpanel.png`), even though the code comment says it opens the panel (`DoNow.tsx:119-122`).

**UI-5 (major): Too many item verbs.** The detail panel footer shows Snooze · Done · Not now · Resolve (`workpanel`). Triage's panel shows Accept · Snooze · Done · Not now · Resolve (`inter/triage-panel.png`). `done` and `resolve` both end in `state:'done'` (`detail/lib/mutations.ts:64-67`), and Snooze and Not now both defer. Triage rows add a, e, m, n and 1–9. A new teammate can't tell Done from Resolve or Snooze from Not now.

**UI-6 (major): Internal words reach the screen** (*Usable daily*, #12). Examples: "canvas", "Tell Slackbot", "read-back", "CF / CR", "Apply · 2 first", "Stage", "L0–L4", "One-click", "preconfiguration", `Use_Case__c` (`time/UseCasesView.tsx:38,51`), and decision IDs in user strings, "(D-63)" (`engines/activity/use-cases.ts:440,443`, `server/landings/ops.ts:57`; 10 such strings). An SE knows Org62 and VDP. They don't know what a canvas is.

**UI-7 (major): Re-auth and errors aren't packaged-app-ready** (#12). The VDP fix is a copyable `python3 ~/.claude/scripts/refresh_vdp_fir_cookie.py` (`health/health-1440.png`, `set-connectors`), next to a Run refresh button that does the same thing. Org62 degraded shows `REQUEST_LIMIT_EXCEEDED` raw. `api()` doesn't wrap a non-JSON 200 (`src/client/api.ts:112`), so a whole page turns into "Home couldn't load · SyntaxError: Unexpected token '<'" (`inter/home-err-details` run; triggered by a dev-server clobber, but the path is real for any proxy or HTML error page). `PanelError` shows the raw message (`HomePage.tsx:389`). There's no per-connector "what broke, what to do next" model in the UI beyond VDP's.

**UI-8 (minor): Brand name.** The sidebar says "Command Center" (`shell/Sidebar.tsx:43,326`, 18 files), while the README, CLAUDE.md and package call it "Control Center" (26 files).

**UI-9 (minor): Sidebar counts are a firehose of their own.** Six numbers (20, 9, 3, 2, 1, 7). Today's 20 is the loudest, and it's not something that needs you. At 1280 px the sidebar collapses to a rail (`nav.ts:93`, `SIDEBAR_AUTO_COLLAPSE = 1440`, so most 13–14" laptops get the rail). There the Getting started badge "14" overlaps the History icon and all counts vanish except a dot (`home1280/today-1280.png`).

**UI-10 (minor): Chords have run out of mnemonics.** `g y` Today, `g l` Activity, `g c` Assistant, `g i` History, `g s` Health (`nav.ts:41-64`). I count 153 distinct key strings registered across components. The cheat sheet is page help (`?`) rather than one list (`inter/cheatsheet.png`), and ⌘K means both the global palette and "Find a setting" on Settings (`set-*`).

**UI-11 (minor): Assistant has four entry points** (sidebar page, topbar button, ⌘J panel, and "Search or ask…" in ⌘K), plus "Ask about this VDP" and "Ask the assistant" links. The panel itself is clean: the proposal card shows a before → after diff, Apply ⌘↵ and Discard, and "Nothing changes until you apply" (`asst-fixture/assistant-1440.png`). Its limitations are capability, not layout (lane #4). Two UI gaps remain. Suggested prompts are generic ("Why is my #1 first?", `/rescan slack 2d`). And there's no visible statement of what it can read or which model it's using beyond the "Sonnet" picker, so users don't know what to ask.

### Per page

| # | Page · shot | Problem | Code |
|---|---|---|---|
| UI-12 | Home `hometall` | At 1440 the panel opening squeezes Home to ~650 px: ribbon labels become "0…", account chips render empty boxes, Chase column drops (`inter/home-asstpanel.png`). Home doesn't reflow to a single column with the panel open. | `home/home.css`, `HomePage.tsx` |
| UI-13 | Home | Masthead sentence + Saturday line + ribbon + capacity strip + "since you left" + "5 agent runs" take ~330 px before the first card; at 1280×800 only Do now is above the fold (good) but the 4 columns are entirely below it. Header line "Top 3 of 9 across every t…" truncates. | `Masthead.tsx`, `DayRibbon.tsx` |
| UI-14 | Today `today` | Duplicates Home (UI-1); a third vertical rail "Agent's plan 4" adds another queue. | `today/TodayPage.tsx` (738 lines) |
| UI-15 | Triage `triage` | Good keyboard model and grouping; but 6 groups incl. "possible missed opps" (also on Deals) and "Looks done" (also on Home/Work). | `app/triage/_triage/*` |
| UI-16 | Outbox `outbox` | Clear. "Approve: push draft" is jargon ("push"); panel took >1.5 s skeleton on open (`inter/outbox-panel.png`, not verified on db). | `app/outbox/_outbox/OutboxRow.tsx` |
| UI-17 | Work `work` | 7 tabs × 4 filters × 2 groupings; "Do now 9" collides with Home's term; re-auth banner here too. | `app/work/_list/WorkPage.tsx` (630 lines) |
| UI-18 | Work item `workitem` | Strong page (why it's first, next step, context pack); header verb row has 4 synonyms (UI-5). | `detail/ItemDetail.tsx` (700) |
| UI-19 | Deals `deals` | 6 KPI tiles + chart + Log & fix + Think ahead + accounts = a dashboard, not a to-do; its Log & fix duplicates Home's. Header link "Fix in Health" for "VDP links unverified". | `deals/DealsView.tsx` |
| UI-20 | Deals ▸ DCs `dcs` | Half the screen is an empty "Requests 0" card; DC rows truncate ("rea…", "read 31…"); topbar says "Deals" here but "Missed opportunities" on the sibling tab. | `deals/DcView.tsx`, `routes.ts:53-54` |
| UI-21 | Account `account` | Breadcrumb "Deals › Manufacturing" (industry, not account); "Worth a closer look 0" with 1 item. | `deals/AccountPage.tsx` |
| UI-22 | Briefs `briefs` | Clean master–detail; "Promote → Triage" is a fine pattern. Watches config sits here and in Settings ▸ Watches. | `app/briefs/_briefs/BriefsPage.tsx` |
| UI-23 | Agents `agents` | "Open in Claude" overlaps "14h ago" in the Running column; three columns with one item each waste the page. | `agents/AgentsView.tsx` |
| UI-24 | Activity ▸ Log it `act-week` | Quarter header + "Waiting on you" duplicates Ledger's header (`act-log`) almost verbatim; ready rows use bare inputs (hours box "1", opp, task type) without labels. | `time/QuarterHeader.tsx`, `ReadyToLog.tsx` |
| UI-25 | Activity ▸ Needs you `act-needs` | The best page for #6 (suggestion + Accept), but suggestions are below the fold of each row; "Log again / Leave out" vs "Accept" vs pickers: three interaction models in one list. | `time/NeedsYou.tsx` |
| UI-26 | Activity ▸ Weeks `act-weeks` | Week strip clipped at left ("4"); date input clipped "11/17/2026"; a 7-column editable table. | `time/ActivityTable.tsx` |
| UI-27 | Activity ▸ Ledger `act-log` | Topbar title reads **Time** (other views read Activity, VDP view reads **VDP**). | `time/ActivityLogView.tsx`, `VdpView.tsx:58` |
| UI-28 | Activity ▸ Forecast (SE) `act-forecast` | Reachable by URL for an SE; empty state "Not in your role's preconfiguration" (has a link: no dead end, but jargon). | `TimePage.tsx:146-152` |
| UI-29 | Activity ▸ VDP `act-vdp` | Autopilot toggle, Run refresh, re-auth banner, push bar, "Find assets · about $1.40", tree with Apply · N first: dense but coherent; disabled items need the reason visible without hover. | `time/VdpChanges.tsx` (564), `VdpItem.tsx` |
| UI-30 | History `history` | Good. Calendar cells show hours but "4.2…" truncates. | `history/HistoryPage.tsx` |
| UI-31 | Health `health` | Good structure (problem first, sources, ledger/jobs/errors/spend). Spend lives here *and* Budgets in Settings. Org62 "Rescan" for a rate-limit is a tempting wrong click. | `health/*` |
| UI-32 | Settings `set-*` | 4 columns at 1440 (sidebar, section nav, form, effects rail) leave the form ~550 px: segmented controls overflow ("Au…", `set-agent`), Connectors' action column clipped to "S" (`set-connectors`). Title "Settings" twice. "Profile & role" and "Role & rules" overlap. Save models differ per section ("Save", "Each block saves on its own", "Nothing to save here", "Save autonomy"). 15 sections, ~4 of which a teammate touches. | `settings/*`, `settings.module.css` (1,742) |
| UI-33 | Onboarding `onboarding` | Clear 6-step flow with a preview rail. "Specialist AE · Preview" is good honesty. | `onboarding/steps.tsx` (722) |
| UI-34 | Getting started `inter/gettingstarted.png` | 17 steps; 10 are "Tour <page>" (`guide/pages.ts:301-316`). It should be 4–5 outcomes ("Connect sources", "Approve your first draft", "Log your first week"). | `src/guide/checklist.ts` |

### Components and styling

**UI-35 (major): No shared row or card contract.** There are 45 `*Row` and ~40 `*Card/*Section/*List` components (`grep -rhoE "function [A-Z]\w*(Row|Card|List|Section)"`). Triage alone has 7 row types (`TriageRows.tsx:83-358`), and Activity has ~12 (`ReadyRow`, `UpdateRow`, `UseCaseRow` twice in `ReadyToLog.tsx:165` and `UseCasesView.tsx:68`, `NeedRow`, `InternalRow`, `LogRow`, `AutosaveRow`, `VdpItemRow`, `NodeRow`, `CandidateRow`, `ClosedRow`). `domain/WorkRow.tsx` is used in 12 files, and `lists/LineRow.tsx` in only 4. Most rows share the same skeleton: title, why line, badges, source link, one primary verb, and quiet hover verbs.

**UI-36 (major): Three styling systems.** Tailwind utilities with tokens (`src/ui/*`, `app/globals.css` imports `src/styles/brand.css` with 174 vars), CSS modules (`settings.module.css` 1,742 lines, `onboarding.module.css` 681, `assistant.module.css` 461), and global prefixed CSS (`today.css` 1,010, `home.css` 384 with 251 `hm-` rules, `lists.css`, `deals/context.css`). Tokens are respected: only 8 hex literals in components, and `npm run contrast` passes all 140 pairs in dark and light. Layout and density, though, are re-implemented per page, which is why Home, Settings and Activity each break differently with the panel open (UI-12, UI-32).

**UI-37 (minor): Pages are split across two trees.** Triage, Outbox, Work and Briefs live in `app/*/_*`, and every other page lives in `src/components/<page>`. Big files: `deals/MissedView.tsx` 977, `domain/NbaCard.tsx` 848, `composer/Composer.tsx` 844, `today/TodayPage.tsx` 738, `onboarding/steps.tsx` 722, `detail/ItemDetail.tsx` 700. `src/components` totals 66.6k lines, plus 7.2k in `app/*/_*`.

**UI-38 (minor): Dev-only overlap.** The floating "Dev" pill overlaps panel footers ("Resolv…", `workpanel`). It's dev only, but it hides the last action in every screenshot review.

**UI-39 (info, env): Icons and fonts.** `npm run dev:web` (the lane command in CLAUDE.md) skips `predev`, so with no `public/icons` the app renders iconless with no warning (first screenshot set). Without Salesforce Sans installed it falls back silently, and Chrome logs "Failed to decode downloaded font" because `/fonts/*.ttf` falls through to HTML. A packaged app must bundle or substitute both.

## 4. Recommendations (prioritized)

**R1. One "Needs you" queue as the backbone (L; dependencies: SCANNERS, DATA-MODEL lanes).** Replace the per-page need lists with a single server-built feed of *actions waiting on me*. Each entry has a kind (reply, approve draft, confirm done, answer question, log time, claim DC, VDP item, re-auth, review agent run), one primary verb, a why line, a source, and a group key. Home shows its top slice, the sidebar shows **one** count, and pages filter it (`?kind=`). DC gaps, Looks done and Unlogged time each get exactly one row. The rows already exist as `HomeRow`, `needs/decisions` and the Activity Needs-you rows, so this is consolidation, not invention. `needs/decisions` (`src/contract/routes.ts:242-244`) is the right seed for snooze and not-needed. Migration: additive. Keep existing routes and add `GET /needs` composed from the same engines. Pages move over one at a time, and decisions stay keyed `{rule, subjectId}`.

**R2. Drafts: one queue, one verb (S–M; dependency: R1 optional).** On Home, collapse every draft surface into one Do-now card, "Approve N drafts", that opens the panel on draft 1 with Next/Prev (the panel already pages, `DoNow.tsx:119`). Drop "Send draft" rows from Reply & approve (`build.ts:1422`), and mark item cards that have a draft with a ✦ chip only, opening that draft. The verb is "Review" everywhere ("push draft", "Send draft", "Approve: push draft" all become Review → Approve). Fix the count/link mismatch at `build.ts:1422`. No data change.

**R3. Merge Today into Home (M).** Home gets a "Plan" toggle (Today | Next day already exists) whose second mode is Today's timeline and Run of day. Delete the `/today` sidebar entry and redirect it to `/?view=plan`. Rename Work's "Do now" group to "Due today". There's no data change, and the `today` count key goes away.

**R4. Activity: three tabs, plain words (M; dependency: TIME lane #6).**
- **To log** = today's Log it + Needs you merged. Rows with a suggestion show inline Accept. Rows needing input sit on top, ready rows below, and one "Log N" button.
- **History** = Weeks + Ledger, with a week/quarter picker on one page.
- **VDP** = Changes, with My VDPs as a filter.
- Use cases become a row kind inside To log and VDP plus a filter, not a tab. Forecast appears only for the AE persona, as its own tab.
- One topbar title, "Activity", for all of them (`ActivityLogView.tsx`, `VdpView.tsx:58`).
- Replace the vocabulary: canvas → "batch", Tell Slackbot → "Send to Org62 via Slackbot", read-back → "checked in Org62", CF/CR → spelled out with a tooltip.
- Strip `(D-nn)` and API names from user strings (add a lint rule, R10).

Migration: keep `?view=` values as redirects (`routes.ts:142` already does it for `/time`).

**R5. Navigation: 7 items, one count (S).** Target sidebar: **Home · Needs you (count) · Outbox · Work · Deals · Activity · Assistant**, with Briefs, Agents, History and Health one level down: Briefs under Work ▸ Briefs (or Home's footer), Agents under Work ▸ Agents, History under Activity ▸ History or Home's calendar, and Health behind the status line. Counts are shown only on Needs you and Outbox (red only when sends are waiting or failing). Keep the chords but make them mnemonic for the 7 (`g h`, `g n`, `g o`, `g w`, `g d`, `g a`, `g j`), and keep old chords as aliases for a release. This is a config change in `nav.ts` plus redirects.

**R6. Item verbs: two menus (S).** **Done ▾** (done by me / someone else / not mine / not needed: today's Resolve picker) and **Later ▾** (tomorrow / next week / pick date / not now). Triage keeps Accept and Dismiss. Map `resolve` → `done` with a reason and `not-now` → snooze until the next working day (`detail/lib/mutations.ts:36-47`). The API is unchanged and only labels and menus move. Keys: `d` Done, `l` Later, `⇧D` Done ▾.

**R7. Connection errors as a product surface (M; dependencies: CONNECTORS and PACKAGING lanes).** Each connector state gets a typed problem with *what broke, impact, one button, and fallback text* (`expired_auth` → "Sign in to VDP" button running the refresh script with no command shown, plus a "Show command" disclosure for power users; `rate_limited` → "Org62 is throttling; retrying at 09:12, nothing to do"; `mcp_missing` → "Install the X connector" with steps). Health owns the detail. Everywhere else shows one status-line entry and one Needs-you row, not banners on Work, Deals and Activity. Wrap non-JSON responses in `ApiError('upstream_unavailable')` (`src/client/api.ts:112`) and never render `error.message` raw. Show "Something went wrong loading Home. Retry · Copy details for feedback" instead. That hooks into the Feedback post (D-56).

**R8. Settings: 5 sections plus Advanced (M).** **You** (profile, role, display, time), **Sources** (connectors, watches, scanning), **Sending & autonomy** (sending, agent behavior, budgets), **Feedback**, **About**. Priority policy, Thresholds and Closing work move under **Advanced** (collapsed). Drop the effects rail below 1600 px and show effects inline under each control. Use one save model, autosave with Undo toast, which matches `src/client/save/autosaver.ts` already in the repo. Settings data keys don't change.

**R9. Getting started: 5 outcomes, tours on demand (S).** The checklist becomes "Connect sources · Pick your role · Approve a draft · Log a week · Claim a DC". Page tours are reachable from `?`. Ship a sample-data "try it" mode using the `sample-data/` world so a teammate sees a full app before connecting anything (*Usable daily* from day one).

**R10. Component architecture a teammate can extend (L; dependency: CODE-HEALTH lane).**
- `src/ui`: primitives only. It already exists, so keep it.
- `src/components/kit`: four composites with a typed contract.
  - `ActionRow` with slots: lead (date/edge), title, why, meta chips, source link, primary verb, overflow verbs, an inline expansion for pickers, and states (new, gone, selected, held). WorkRow, TriageRow, OutboxRow, NeedRow, ReadyRow and VdpItemRow become configurations of it.
  - `QueueSection`: title, count, sub, "Select all", "See all", and live-list wiring from `lists/live-list.ts`.
  - `PageHeader`: one title source, sentence, tabs, and right actions. This kills the Time/VDP/Activity title drift.
  - `DetailPanel` with a `sections[]` registry: `panels/register.ts` is already a registry, so extend that pattern.
- Pages are thin: `src/pages/<name>/` holding the page plus derive. Move `app/*/_*` pages into it so `app/` holds only routing.
- Styling: Tailwind and tokens only for new code. Freeze CSS modules and global CSS and migrate when a file is touched. Add lint rules for no new `*.module.css` or global prefixed CSS, a max file length (~400 lines, warn), and no `D-\d+` or `__c` inside JSX strings.
- A `/dev/kit` gallery exists (`app/dev/kit/*`). Make it the place each kit component is specified with fixtures.

This is incremental, one page per PR, and needs no contract change.

**R11. Responsive with the panel open (M, after R10).** Each page declares a narrow layout (one column) used whenever the content width is below ~900 px. Home drops to Do now plus one combined list. Raise the sidebar auto-collapse threshold or show counts on the rail, and fix the overlapping "14" badge (`home1280`).

**R12. Quick fixes (S, any lane):** UI-3's count mismatches; Sidebar brand "Control Center" (`Sidebar.tsx:43,326`); Agents column overlap (UI-23); Deals ▸ DCs empty card collapses to one line; Account breadcrumb shows the account; date input and week-strip clipping (UI-26); Dev pill moves left of panel footers; `dev:web` runs `sync-brand-assets` (or warns) so lanes see icons.

### Target IA (an SE on a normal day)

```
┌ Sidebar ───────┐┌ Home ─────────────────────────────────────────────────────────────────┐
│ Home           ││ Fri 20 Nov · Today turns on the 13:00 ACME demo.        [Today|Plan]  │
│ Needs you   12 ││ ▁▁▁▁▁▁▁ day ribbon (one line, meetings + free blocks) ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│ Outbox       2 ││                                                                       │
│ Work           ││ NEXT 3                                                                │
│ Deals          ││ ┌1 Kick off demo-org build ─┐┌2 Approve 2 drafts ──┐┌3 Reply to Dana ┐│
│ Activity       ││ │ why · due 09:15 [Open ⌘↵] ││ Peter · Marcus [Review]││ ✦draft [Review]││
│ Assistant      ││ └───────────────────────────┘└─────────────────────┘└────────────────┘│
│                ││                                                                       │
│ ● VDP sign-in  ││ NEEDS YOU · 12              by: [All] Reply  Log  Deals  Confirm      │
│ ● 6/8 sources  ││  ▸ Confirm: Hooli NCE ref arch looks sent          [Confirm] [Not yet]│
│ Settings       ││  ▸ Log 8.75 h: 6 meetings have a suggested opp     [Review 6]         │
│                ││  ▸ Claim DC on 3 opps                               [Review]          │
│                ││  ▸ Sign in to VDP (value plans stale)               [Sign in]         │
│                ││  … 8 more · See all →                                                 │
│                ││                                                                       │
│                ││ COMING UP (14 days, collapsed): 4 · WAITING ON OTHERS: 5              │
└────────────────┘└───────────────────────────────────────────────────────────────────────┘
```

Rules for this layout:
- The first screen holds the 3 next things, then **one** grouped queue capped at 5 rows. Group rows aggregate (one "Log 8.75 h" row rather than six).
- Everything else is one click away: the Needs you page is the same queue unfiltered, with bulk keys.
- Pages (Work, Deals, Activity) are *reference and bulk tools*, not competing inboxes. Each shows its own filtered slice of Needs you at the top, and only that.

## 5. Decisions for Tristan

| # | Question | Options | Recommendation |
|---|---|---|---|
| T1 | A single "Needs you" queue (R1) vs today's per-page needs | (a) keep per-page lists, fix counts; (b) one queue, pages filter it | **(b)**. It's the only way "never lose track" and "one channel, not noise" both hold. It touches Home, Deals, Activity, Triage and Health, so it's a multi-lane chunk. |
| T2 | Today page | (a) keep both; (b) fold into Home as a Plan mode | **(b)**. *Tenet: Calm* plus one answer to "why #1" (*Legible*). |
| T3 | Triage as its own page | (a) keep; (b) Triage = the "Confirm" filter of Needs you | **(a) for now, (b) after R1 lands.** Guesses-to-confirm is a distinct job, but Looks done and Missed opps should leave it. |
| T4 | Activity tab model (amends D-72) | (a) current 6+2 tabs; (b) To log · History · VDP (+ Forecast for AE) | **(b)**. This reopens D-72's "one job per tab" by merging Log it and Needs you, which the owner's #6 ("I don't want to think about this") argues for. |
| T5 | Styling direction for new code | (a) keep three systems; (b) Tailwind and tokens only, freeze modules and globals | **(b)**, enforced by lint. Migration is opportunistic. |
| T6 | Product name | Control Center vs Command Center | Pick one before packaging. The repo, README and CLAUDE.md say **Control Center**. |
| T7 | Re-auth UX | (a) show the command; (b) button-only with "Show command" disclosure | **(b)**. *Tenet: Low upkeep, team-portable* ("auth refreshes are scripted, not tribal knowledge"). |

No recommendation here conflicts with a design tenet. R1 and R2 change where approvals are *shown*, not the gate (*tenet: Nothing leaves without approval* is untouched: Outbox remains the only send path).

## 6. What's fine, don't touch

- **The live-update model** (`docs/UX.md` "Live updates", `lists/live-list.ts`, `live-merge.ts`, `stable-order.ts`): stable order, held pill, departures fade, the panel survives "handled elsewhere". This is better than most commercial apps. Build R10's `ActionRow` on top of it.
- **The Home engine's caps and "one color signal per card"** (`build.ts:70`, `:673`), and the masthead sentence as an idea (shorten it rather than remove it).
- **The work item page** ("Why it's first", "Next step", plan with you/agent time, context pack: `workitem`). It's the best expression of *Legible*.
- **Outbox page structure** (Approve · Retry · Going out later · Sent, with dry run stated up front).
- **Assistant proposal and receipt cards** (diff, Apply ⌘↵, Discard, Undo).
- **Onboarding flow** (6 steps with a preview rail), History calendar, and Health's "problem first" banner.
- **Tokens and contrast** (`src/styles/brand.css`, `npm run contrast`: 140 pairs pass in both themes).
- **The ⌘K palette** with chords listed, and per-page `?` help.

## 7. Open questions / not verified

- **Real-data density.** Mock has ~25 items and 3 drafts, so I couldn't reproduce the owner's "long list of drafts" at real volume. The analysis in UI-4 comes from the engine code. With Postgres absent, I couldn't check db-mode counts or the first-scan (FirstScanBanner, FillingIn) states.
- **Shared-worktree flakiness.** Another reviewer ran `next dev` on :4350 in the same worktree and `.next` was clobbered twice. While that happened `/api/v1/*` returned 500 or HTML, which produced the "Home couldn't load" capture. Clicking the Do-now Outbox card and the Feedback and Capture overlays couldn't be captured reliably (Capture shows only the skeleton). I don't count the clobber itself as an app bug, only the raw error rendering (UI-7).
- **Coverage gaps.** Only 1440 (and two 1280) widths were captured, not 1920/2560 or light theme. The Specialist AE persona (Forecast default, Home differences) wasn't exercised. Composer, CanvasReview and the Initiative page weren't screenshot. I didn't do a keyboard-only or screen-reader pass, so the aria labels look thorough on reading only.
- **Needs-you volume.** How many need kinds an SE really sees per day in db mode would size R1's grouping rules. `npm run scan:report` on the work machine would answer it.
