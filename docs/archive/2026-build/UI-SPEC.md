# Control Center: UI spec (v1, mock-first)

**Status:** v1, 2026-11-05. The orchestrator owns this file. Builders implement it and raise a `blocker` instead of diverging.

**Source of truth for *what*:** `docs/archive/2026-build/REQUIREMENTS.md` (R-UI-1…20, R-BE-1…5). This file defines *how it looks and behaves*.

**Read alongside these research briefs.** They live in the main checkout and are git-ignored, so read them by absolute path:

| Brief | Use for |
|---|---|
| `~/Projects/control-center/docs/research/08-command-center-patterns.md` | Patterns, wireframes, keyboard, NBA anatomy |
| `~/Projects/control-center/docs/research/07-vdp-design-system.md` | Structure, density, component sources in `~/Projects/vdp-app` |
| `~/Projects/control-center/docs/research/12-salesforce-brand.md` | **The token block wins over 07 §1.2 for color, type and icons** |
| `~/Projects/control-center/docs/research/09-headless-sources-spike.md` | Connector states and re-auth |
| `~/Projects/control-center/docs/research/10-local-signals-inventory.md` | Claude session states, trainings, tools |

Examples in this file use placeholders (ACME, Globex, Dana). The mock seed uses real data, kept outside the repo.

---

## 1. Principles (non-negotiable)

1. **Three things, then counts.** Home leads with the Top 3 next best actions. Everything else is a count you can open.
2. **Every item carries its next action, ready.** The draft, plan or payload appears in place, in the destination's real format. There is exactly one primary action per card.
3. **Provenance in one hop.** Each item has a one-line *why* plus source chips. Hover or `?` shows the full reasoning, and `o` opens the source.
4. **Guesses look different from facts.** Confidence is categorical (*Sure / Likely / Guess*). Suggestions use a dashed treatment. Guesses stay in Triage.
5. **Undo over confirm, except at the border.** Internal changes apply instantly and can be undone. Anything leaving the machine needs an explicit Send or Approve, then a confirm.
6. **Periphery by default, centre by exception.** Only two things interrupt: something becoming *waiting on you*, or something *breaking*.
7. **Nothing moves under your cursor.** The ranking stays stable. New info is announced ("Re-rank ready · 2") and applied when you choose. Drafts you've touched are never overwritten.
8. **Lead time beats effort.** Show *your* minutes and *agent* minutes separately, plus a **start by** time.
9. **Keyboard-complete, optimistic, sub-100 ms.** Every action has a key and a ⌘K entry, and the UI updates before the server confirms (R-UI-20).
10. **Resume exactly.** Selection, scroll, open sheets, drafts and chat survive restarts. After downtime, the "Since you left" digest shows before any re-rank.
11. **Chat is a control surface with receipts.** It acts on the thing in view and reports *before → after* with Undo. It can create Outbox drafts but never sends.
12. **Show staleness where it matters.** A broken connector marks the affected items and panels, not just the Health page.
13. **Every task says what it's for.** Each task shows a purpose line, its initiative, and siblings and assets one click away (R-UI-20).
14. **It looks like Salesforce and works like VDP.** Salesforce type, color and icons sit on VDP's hairline, mono-eyebrow, dense structure (R-UI-17).

## 2. Information architecture

**Chrome visuals follow brief 12 §8:**
- a global header (44 px);
- a navigation bar (36 px) with the waffle (the **Tools** app launcher, R-UI-13), the app name and tabs with a 3 px indicator;
- a bottom **utility bar** (32 px) for Capture, Since you left, catch-up, **Dry run / Live send**, spend and shortcuts;
- the assistant styled as an Agentforce-like panel with a Claude identity.

The brand ramp defaults to **Lightning Blue `#0176D3`**, which matches the Salesforce-branded Headless demos the owner referenced. `data-sf-theme="cosmos"` switches it to `#066AFE`. The toggle lives in the user menu, so both can be compared in the mock review. The font is Salesforce Sans; Avant Garde isn't used. No Astro.

This spec owns the IA and placement. Brief 12 owns the visuals.

**What goes where** (layout from this spec):
- **Left:** app mark and "Control Center".
- **Center:** nav tabs `Today · Triage · Work · Briefs · Deals · Agents · Time · Outbox`. Counts appear only where you must act: Triage n, Agents n waiting, Outbox n.
- **Right:**
  - the ⌘K search/command box;
  - a **scanner pulse** ("Live · 40s"), which shows a catching-up state after downtime;
  - the **health dot**, which opens `/health`;
  - a budget chip that appears only at 80% or more of the daily soft budget;
  - a chat toggle (⌘J);
  - the user menu, which holds Settings, Density and Theme.

| Route | Page | Answers | Depth |
|---|---|---|---|
| `/` | **Today** | "What do I do now?" | Home |
| `/triage` | Triage | "What came in that might be mine?" Covers guesses, mapping questions, missed-meeting takeaways and missed-opp hits | Page |
| `/work` | Work | "Everything I owe." Tabs: All open · Said by me · Asked of me · Promises · Trainings · Snoozed · Done. Filters: account, opp, initiative, source | Page |
| `/work/[id]` | Work item | Full page of the item; the side sheet is the same component, narrower | Page |
| `/initiatives/[id]` | Initiative | Purpose, summary, child tasks, assets, people, opp, sessions, timeline | Page |
| `/briefs` | **Briefs** (R-UI-21) | "What happened that I might care about?" Channel/source briefs (e.g. `#team-updates`) and **opportunity briefs**, each with ranked "worth a closer look" highlights → promote to Triage/task or dismiss | Page |
| `/deals` | Deals | Accounts → opps from my side. Tabs: My deals · **Missed** (R-UI-14) | Page |
| `/deals/[accountId]` | Account | Opps, hours QTD, DC/VDP status, initiatives, tasks, assets, sessions | Page |
| `/agents` | Agents | Claude Code sessions plus app runs plus tool runs. Tab: **Tools** (the plugin registry) | Page |
| `/time` | Time | Week timeline, activity-log table, canvas sync, Org62 status | Page |
| `/outbox` | Outbox | Pending and sent, by destination, with verification | Page |
| `/health` | Health | Connectors, re-auth, scan ledger, jobs, errors, spend | Page (via the dot) |
| `/settings` | Settings | Profile and role, **priority policy**, agent behavior, sending, budgets, density | Page (via the user menu) |

**Drill model** (same everywhere):
- `Space` expands inline.
- `Enter` opens a **side sheet**. It is non-modal, keeps the list visible, shows "n of N", and `j`/`k` drive it.
- `⇧Enter` opens the full page.
- Modals are used only for quick capture and short blocking confirms.
- The sheet and the page are built from the same field components.

## 3. Frame and responsiveness

The app is a cockpit: the **page never scrolls as a whole**. Each panel scrolls on its own (`h-[calc(100vh-var(--header))] overflow-y-auto`). There is no `max-w-*` on frames; text measure is capped only inside prose (`max-w-[72ch]`). Panels use container queries (`@container`), not viewport breakpoints.

| Viewport | Today layout |
|---|---|
| 1280–1359 | Header strip · **day ribbon** (horizontal) · NOW (fluid) · rail 340 px with **[Status] ⇄ [Chat] tabs**, ask bar always visible. The side sheet (560 px) overlays the right of NOW without being modal |
| 1360–1599 | Day spine 260 · NOW fluid (cards up to 720 px) · rail 360 (Status ⇄ Chat tabs) |
| 1600–1919 | Day 300 · NOW 720 · rail 400. Cards 2–3 show their draft's first line |
| 1920–2399 | Day 300 · NOW 720 · **Status 360 + Chat 440 as separate persistent columns** |
| ≥ 2400 | Adds a **docked Detail column, 600 px**, between NOW and Status. The side sheet becomes a real column. Centred, about 2440 px |

- Other pages use a **list + side sheet**, with a docked detail at 2400 px and up.
- Chat is a tab in the right rail below 1920 px and its own column at 1920 px and up.
- The chat dock can be resized from 360 to 560 px and collapsed to a 44 px rail. Its width is remembered.
- **Density:** `data-density="compact"` (the default) or `"comfortable"` on `<html>` scales the `--row-y` and `--panel-p` variables. Rows are 32–36 px compact.

## 4. Today (home), zone by zone

### 4.1 Header strip

The header strip holds at most four facts:
- the date and **next meeting countdown** ("ACME demo in 3h55m");
- a **capacity bar**: focus time left vs planned work, with the over or under amount;
- the **nearest deadline** (for example "Q4 log 12.5 / ~60 h · due Fri 12 PT");
- the catch-up state after downtime ("Catching up: Slack 60% · Gmail ✓").

### 4.2 Day spine (left)

- Meetings appear as blocks (`border-l-2` brand). Attended ones show ✓; missed ones show **✕ greyed, with a "2 takeaways → tasks" chip** (R-UI-3).
- Work slotted into gaps appears as slot labels ("10:05 ▶ Kick off build", "11:30 30m gap: fits Training"). They're labels only, so they don't duplicate cards.
- A **now line** marks the current time.
- **Prep links** sit under meetings ("prep ready ›"). Hovering a spine slot highlights the linked card and the reverse.
- The bottom of the spine shows "Tonight / later": Fit-ins n · Promises n.
- Dragging a slot re-plans internally only. It never writes to the calendar.

### 4.3 NOW stack (center)

- A header shows "NOW · ranked 09:02 ↻", plus a **"Re-rank ready · n"** pill when new info would change the order.
- **Three NBA cards** follow (§5.1). Card 1 is expanded; 2 and 3 are collapsed with their first draft line visible from 1600 px up.
- Then: "12 more today ▾" (expands inline into a dense row list, §5.2) and "Triage 4 ›".
- **Shelves** (compact, one line each, oldest first):
  - **Fit-ins**: trainings and ≤ 30-minute high-priority items, with "fits your 11:30 gap";
  - **Promises**: background "said by me" items with age, plus **Kick off ▸** (for example "Package Beacon for Ravi · 70d").
- A waiting run is promoted into NOW if its task is in the Top 3 or it feeds a meeting within 3 h.

### 4.4 Status rail (right)

Lanes are a **mono eyebrow with a count and the first 1–2 items**. Expanding one opens its page or sheet. The order:
1. **Since you left** (only after 2 h or more away): "6 changed · 4 closed · 2 new ›". It opens the digest sheet.
2. **Waiting on you**:
   - Claude Code sessions with `waiting` status (reason + **Open in Claude**);
   - app-run jobs needing input (**inline answer** chips or a one-line reply);
   - Outbox approvals.
3. **Agents**: n running · n done-review, with the latest line.
4. **Waiting on others**: count, plus the oldest ("Globex SOW · 6d") and a **Nudge** draft.
5. **Closed for you**: count + "undo z". Each entry shows its evidence (R-UI-1).
6. **Health**: "● 8/8", or the broken connector, with **Re-auth**.
7. **Briefs**: "3 new · 5 worth a look ›". It's reading material, so it never competes with NOW. The morning-brief chat message also links the day's briefs.

The **ask bar** sits at the bottom of the rail and is always visible.

### 4.5 Chat

See §6. At 1920 px and up it's a persistent column; below that it's a tab sharing the rail.

## 5. Core components

Build these once in `src/components/` and reuse them everywhere. Names are fixed.

### 5.1 `NbaCard`, the single card anatomy

```
┌ ① ACME · Headless Phase 2 ──────────────────────────── start by 10:15 ┐  rank · entity chip (initiative) · timing
│ Reply to Dana: confirm Thursday demo scope                    Likely   │  verb-first title · confidence word
│ For: ACME demo Thu 14:00 · you 5m · agent — · due 11:00 · asked 2h ago │  PURPOSE line · effort split · due · age
│ Why: Dana asked in #acme-ext; scope changed after Tue call     [3 ›]   │  ONE line + source chips (hover = full)
│ ┌ Slack · #acme-ext · thread ──────────────────────────────────────┐   │  destination chip = channel profile
│ │ Hi Dana, confirmed for Thu. Scope: …         (3 lines, Space ▾)  │   │  channel-accurate preview in place
│ └──────────────────────────────────────────────────────────────────┘   │
│ [Send ⌘↵]  Edit e  Shorter  Snooze s  Not now n  ↗ Slack     ● NEW 2   │  ONE primary · secondaries · source · new-evidence dot
│ ↻ Updated 09:58: Dana added "include pricing" → draft revised ▸        │  update strip (diff toggle, 24 h)
└────────────────────────────────────────────────────────────────────────┘
```

- **The primary action matches the verb:**
  - Send (opens the composer confirm);
  - Start in Claude (for big builds: a `claude://code/new` deep link);
  - Run tool (R-UI-13);
  - Log (activity);
  - Review;
  - Answer.
- **Low confidence** shows up to three alternatives ("Reply · Nudge AE · Wait") in place of the single primary.
- **"Not now" captures a reason**, with quick chips: done elsewhere · not mine · later · wrong account.
- **If you've touched the draft**, the update strip becomes "New info: X. Update draft? (diff) [Apply] [Keep mine]" (R-UI-20).
- **While the backend is re-evaluating**, a subtle "re-evaluating…" shimmer appears on the why line. The card never blanks.

### 5.2 `WorkRow`, a 36 px dense row

`[priority bar 3px] [state icon] [title (truncate)] [purpose/initiative chip] [source chips] [account] [effort mono "45m"] [due/start-by mono] [NBA verb chip] [new dot] [age]`

Row actions show on hover or focus: `d` done, `s` snooze, `e` edit, `o` open source.

### 5.3 Primitives

| Component | Notes |
|---|---|
| `SourceChip` | Slack · Gmail · Calendar · Drive · Gemini · Org62 · VDP · Claude · Manual. Uses the icon plus a tonal pair; clicking opens the source |
| `ConfidenceWord` | Sure / Likely / Guess. A word, never a percentage |
| `StatePill` | Tones ok/warn/risk/brand/neutral/ai. Work states are in §11 |
| `EffortSplit` | "you 10m · agent ~1h40m" in mono |
| `StartBy` | "start by 10:15", which turns warning within 15 min and danger when late |
| `EntityChip` | Account/opp/initiative/person, with a letter-avatar fallback. There's no third-party favicon fetch by default |
| `ContextChip` | Chat context; removable |
| `ReceiptCard` | Chat or engine changes as before → after rows, with per-line Undo and Undo all |
| `ProposalDiff` | Engine-proposed change to a user-locked field, with Apply and Keep mine |
| `SideSheet` | Non-modal and resizable. Shows "n of N", j/k, Esc returns focus to the exact row. Docks as a column at 2400 px and up |
| `CommandPalette` | ⌘K. Shows the focused item's actions first, each with its shortcut. Search and commands share the box, with fuzzy matching and synonyms |
| `Toast` | Bottom-left stack of at most 3. Each is about 6 s, with Undo where applicable (§9) |
| `Banner` | Scoped to a page or panel: "Slack disconnected: items below may be stale · Re-auth" |
| `InlineStatus` | "Saved · 2s ago" / "Saving…" / "Couldn't save · Retry" next to the field or row |
| `PanelBoundary` | React error boundary per panel: "This panel failed to load · Retry · Details". The rest of the cockpit keeps working |
| `EmptyState` / `Skeleton` | Every panel has calm empty copy (no emoji) and a skeleton that mirrors the final layout |
| `StaleMark` | A small ☾ plus a tooltip on items whose source connector is broken or behind |
| `KbdHint` | A small mono key hint used in buttons and menus |

## 6. Chat (first-class, R-UI-10)

- **Placement:** docked and non-modal (§3). ⌘J focuses it from anywhere and Esc returns to the list.
- **Context:** the focused card, row or page is auto-attached as a removable `ContextChip`. `@` adds an account, opp, person, initiative, session or file.
- **Slash commands:** `/replan`, `/rescan <source> [2d]`, `/find <query>`, `/log last meeting`, `/why`, `/policy`, `/capture`.
- **Threads:** "Today" is the default thread, and its first message is the **morning brief**. Other threads are tabs. Threads persist across restarts.
- **Streaming:** SSE with these events:
  - `text-delta`;
  - `tool-start {name, summary}`;
  - `tool-result {summary, ok}`;
  - `receipt {changes[]}`;
  - `proposal {id, diff}`;
  - `resource {kind, id, label, href}`;
  - `done`;
  - `error`.
- **Rendering streams:**
  - The text renders live through `renderMarkdown`, with a caret and no spinner.
  - Tool calls appear as one-line mono rows (status dot, tool, human summary) and collapse to "Used n tools" when the answer finishes.
- **Mutations always come back as a `ReceiptCard`** with Undo. More than five changes are staged as a preview with **Apply**.
- **Outbound:** chat can create Outbox drafts but never sends.
- **Composer:** Enter sends, Shift+Enter is a newline, the textarea grows, and dictation (copied from VDP) is available.
- **Footnote:** "Can change tasks, priorities, links and policy, with undo. Never sends."
- **Mock mode:** a scripted responder in `src/mock/chat-script.ts` demonstrates every event type. It includes a re-prioritize with a receipt, a find that links a file, and a policy change with a preview.

## 7. Composer (R-UI-5)

- **Editor:** a single TipTap document with **per-destination capability profiles**:
  - Slack mrkdwn: no headings or tables;
  - Gmail HTML: an email-safe subset.

  The **destination chip** sets the profile, for example "Slack · #acme-ext · thread" or "Gmail · reply-all · to Dana". Switching it shows a **lossy-conversion list**.
- **Toolbar:** disables formatting that the channel can't render. Mentions resolve to real IDs, shown as pills.
- **Preview as recipient** renders from the **serialized payload**. "View payload" shows the exact bytes.
- **Draft ↔ Send** is a toggle per message:
  - **Draft** pushes a Slack/Gmail draft;
  - **Send** posts it.

  Both go through **preview, then a confirm dialog**, then a 10 s "Sending… Undo" window, then execution, then **read-back verification** ("Verified in Slack ✓"). The **dry-run** global switch shows a persistent "Dry-run" badge on the composer, and in dry-run mode a send only renders the payload.
- **Above the editor:** thread context (the last 3–5 messages, expandable). **Below the toolbar:** AI rewrite chips: Shorter · More formal · Add detail · Regenerate.
- **Autosave:** the draft saves about 1 s after typing stops (§8). Once you edit a draft it becomes user-locked, so engines can only propose changes to it.

## 8. Save model per surface (R-UI-18)

| Surface | Model | Notes |
|---|---|---|
| Draft body, recipients, destination | **Autosave** (1 s debounce + blur + nav) | Becomes user-locked once edited |
| Work-item title, due, effort, notes, purpose | **Autosave** | Optimistic, with inline status |
| State changes (done, snooze, accept, dismiss) | **Instant** + Undo toast | Optimistic |
| Activity-log row edits (Time) | **Autosave** per row | The canvas sync is separate and explicit |
| Push activity log to canvas | **Explicit "Sync to canvas"**, with a confirm the first time each day | An approved write target |
| Quick capture | **Enter saves instantly** | Enrichment arrives later as chips |
| Chat-made internal changes | **Instant** + receipt with Undo | More than five changes means preview, then Apply |
| Priority policy (weights/rules) | **Explicit Apply**, with a **preview of the re-rank** first | Versioned; triggers a visible recompute |
| Agent behavior prefs (voice, autonomy) | **Explicit Save** per section | Autonomy changes matter |
| Simple prefs (density, theme, toggles) | **Instant** | |
| Connector config, budget caps, dry-run off | **Explicit Save** + confirm for dry-run off | Credentials and config |
| Tool adapter setup (Agents ▸ Tools) | **Explicit Save** | Half-filled is invalid |
| Watch subscriptions (add/edit) | **Explicit Save** | Changes scanning scope and cost |
| Bulk edits (multi-select) | **Explicit Apply** + Undo | |
| Send / Approve to external | **Explicit + confirm** | The border |

## 9. Feedback matrix (R-UI-19)

Each event uses **one channel**. Anything that needs action **persists** (it's never toast-only).

| Event | Channel |
|---|---|
| You did something reversible (done, snooze, move, chat change) | **Toast** with Undo (about 6 s), and the item shows its new state inline |
| Save in progress / saved / failed | **Inline** on the field or row ("Couldn't save · Retry", with the optimistic change rolled back) |
| An engine updated an untouched draft or NBA | **Inline** update strip on the card (24 h) |
| An engine wants to change a user-locked field | **Inline** `ProposalDiff` on the item |
| Re-rank available | **Inline** pill in the NOW header |
| An item gets new evidence | **Inline** "new" dot on the card or row, plus a count in the detail evidence tab |
| An item auto-closed | **Rail lane** "Closed for you" (no toast) |
| An item reopened, or a sibling was created from new requirements, or you were **looped back in** on a handed-off item | **Inline** on the item ("Reopened: new requirement from X · Undo") + a "Since you left" digest entry if you were away |
| A Claude session or run becomes *waiting on you* | **Rail lane** + **macOS notification**, if the app isn't focused |
| A run failed | **Rail lane** (Agents) + **macOS notification** if the task is in the Top 3 |
| A connector broke and today's data is affected | **Banner** on affected panels + **health dot** red + `StaleMark` on items + one macOS notification |
| A connector is behind or catching up | **Header pulse** only |
| A panel failed to load | **PanelBoundary** in that panel |
| A send succeeded and was verified | **Inline** on the Outbox row and the card ("Verified ✓"), plus a toast with "View" |
| A send failed | **Inline** on the Outbox row + the card + Outbox count; persists |
| Budget at 80% / at the cap | **Header chip** / **Banner** on Health + a toast once |
| A new brief is ready / a highlight is worth a look | **Badge** on the Briefs nav tab + the rail Briefs lane (no toast, no macOS notification unless High relevance and the user opted in) |
| You came back after 2 h or more away | **Since you left** lane + digest sheet |

## 10. Concurrency and live updates (R-UI-20)

- **Data layer:** TanStack Query. Mutations are **optimistic**: `onMutate` patches the cache, `onError` rolls back and sets the inline error, and `onSettled` invalidates.
- **Versioning:** every mutable entity carries `version`, and mutations send `ifVersion`.
  - On a 409 the client refetches and re-applies the user's intent if it doesn't conflict.
  - If it does conflict, it shows a `ProposalDiff` ("Changed elsewhere: keep yours / take theirs").
- **Live channel:** `GET /api/v1/events` is SSE and pushes `{topic, ids, reason}`. The client invalidates the matching queries.
  - Rows **don't reorder under the cursor**.
  - Rank changes go into the "Re-rank ready" pill.
  - New items enter at their natural place, marked; many at once (or while the user is scrolled down or interacting) wait behind a "N new · Show" pill. Rows that leave elsewhere fade out in place; the open panel stays on its item and says so. The full pattern: docs/UX.md "Live updates" (2026-11-14).
- **User-locked fields:** once the user edits a field, engines must propose instead of writing (shown as a `ProposalDiff`).
- **Re-evaluation:** when an item is being re-evaluated (`reevaluating: true`), its card shows the shimmer. If more info arrives, the backend cancels the old job and restarts; the UI just keeps the shimmer.
- **Resume:** the selection, open sheet, scroll positions and chat thread persist in `localStorage`, keyed by route, and are restored on load.

## 11. Work-item states (UI vocabulary)

These map 1:1 to the backend state machine (see `docs/reference/DATA-MODEL.md`).

| State | Pill | Where it shows |
|---|---|---|
| suggested | dashed "Suggested" (ai tone) | Triage only |
| open | none (default) | Today / Work |
| in_progress | brand "In progress" | Today / Work (for example from Drive edits, R-UI-15) |
| waiting_on_me | warn "Waiting on you" | Rail + card; carries a reason (session asked, approval) |
| waiting_on_others | neutral "Waiting on X · 3d" | Rail lane |
| likely_done | ai "Likely done · Confirm" | Card, with a one-key confirm and evidence |
| done | ok "Done" (auto ✓ or manual) plus the **resolution reason** (R-UI-22): "Done by you" · "Handed off → Dana" · "Done by Lee" · "Not needed" · "Duplicate of …" · "Declined" · "Superseded by …" | Closed-for-you / Done tab, with Undo. Handed-off items show the new owner and my involvement (watcher / not involved) |
| reopened | warn "Reopened" + reason | Card (transient label on open) |
| snoozed | neutral "Snoozed until …" | Snoozed tab |
| dismissed | — | Hidden; reason recorded |

**Resolving:** `d` = done by me (the default reason, instant, Undo). `⇧D` opens a small **resolve picker** with reason chips. *Handed off* asks who, with a person picker defaulting to people on the thread, and sets my involvement to watcher or not involved. Auto-closures always carry an inferred reason with evidence (e.g. "Done by Lee: they posted the deck in #acme").

**Looped back in:** if new info on a handed-off item is a **direct ask of me**, the item reopens, or a sibling opens, with the inline label "Looped back in: Dana asked you directly · Undo". Other new info on handed-off items attaches as context only (no task) and may surface in Briefs.

**Kinds** (icon and label): task · commitment (said by me) · ask (asked of me) · training · promise (background) · follow-up (missed meeting) · travel · deliverable (doc/slides, R-UI-15).

## 12. Other pages

- **Triage:**
  - A list with a side sheet, plus single-key `a` accept, `e` edit, `n` dismiss with reason, and `m` merge into an existing item.
  - Mapping questions ("Is this ACME or Globex?") appear as inline choice chips.
  - Groups: Asks & promises · Meeting takeaways · Missed opps · Mappings.
- **Work:**
  - Tabs (§2), a filter row (search, account, initiative, source, kind), and `WorkRow` lists grouped by initiative or due date (toggle).
  - Multi-select with bulk Apply.
- **Work item / initiative detail** (the sheet and the page share components). Layout:
  1. **Header:** the breadcrumb `Initiative ▸ Task`, the title (autosave), the state pill, the purpose line, the next meeting it serves, and the owner.
  2. **NBA** (the `NbaCard` body), with the composer inline.
  3. **Tabs:**
     - **Context** (summary, people, opp/account, linked meeting notes);
     - **Evidence** (a timeline of sources by role: origin · progress · completion · context · contradiction, with **new** markers);
     - **Related** (sibling tasks of the initiative, assets: slides, docs, demo orgs, Claude sessions, tool outputs);
     - **History** (the audit log with per-change Undo, and NBA versions).

  For a **deliverable**, it adds a Drive panel: file, last edit and editor, "changed since item created", and the latest diff summary. It also shows the "updates requested vs made" judgment (R-UI-15).
- **Briefs** (R-UI-21):
  - The left list has two groups. **Watched** holds channels, searches and people from the user's subscriptions. **My opportunities** has one brief per open opp. Each entry shows unread state and a count of "worth a look" items.
  - The right pane shows the selected brief:
    - the period, its sources, and "through 10:41";
    - a summary, in prose up to 72ch;
    - **Worth a closer look** highlight cards, each with a relevance word (High/Medium), reasons tied to *your* accounts, opps, initiatives and policy, source chips, and the actions **Promote → Triage**, **Make task**, and **Not relevant** (which tunes relevance);
    - "Everything else", collapsed, grouped by thread.
  - Subscriptions are managed in a header **Manage watches** sheet: add a channel, opp, account, person or search; set the cadence (daily 7:30, every 4 h, or since last open) and the style (brief or detailed). It uses explicit Save.
  - Opp briefs also appear on the account/opp page in Deals, on a Brief tab.
- **Deals:**
  - An accounts list showing open opps, my DC status, VDP link status, hours QTD and open tasks.
  - The account page has tabs: Brief · Opps · Initiatives · Assets · Sessions · Notes.
  - The **Missed** tab (R-UI-14) has the columns verdict (Claim/Check), opp, amount, stage, close, evidence and other DCs, with the actions *Claim → creates DC task* and *Dismiss with reason*.
- **Agents:** one list across Claude Code sessions, app runs and tool runs, using the state model below. Rows read `title (linked task) · state · elapsed · last event · one action`.

  | State | Glyph | Action |
  |---|---|---|
  | queued | ○ | Cancel |
  | running | ◐ + elapsed | Open log / Open in Claude |
  | waiting_on_you | ⏸ (warn) | **Open in Claude**, or Answer inline for app runs |
  | done_review | ● (brand) | Review, which links back to the task |
  | done | ✓ | — |
  | failed | ✕ (risk) | Retry / Open in Claude |
  | stale | ☾ | Nudge / Stop |

  - **Start in Claude** builds a `claude://code/new?folder=…&q=…` link carrying a `[cc:<id>]` tag. **Open in Claude** uses `claude://code/continue?session=<id>`, and "All waiting" uses `claude://code/needs-input`.
  - The **Tools** tab is the ToolAdapter registry (talk-track, Pulse footprint, estimator). It shows health, inputs and recent runs, and has **Run** buttons that open a short input form (explicit Save/Run).
- **Time:**
  - The top shows a week timeline: meetings, Claude sessions, Drive edits and Slack bursts as lanes, with overlap shading.
  - Below it is the **activity-log table**, with autosave per row. Columns: date · start–end · duration · SE task type · opp (WhatId) · CF/CR · description · status (proposed / approved / synced to canvas / logged in Org62 / verified) · source evidence.
  - There's quarter progress and a **Sync to canvas** button, with "last synced 17:30 · 3 rows changed since".
- **Outbox:**
  - Groups: Pending approval · Scheduled · Sent (verified/unverified) · Failed.
  - Each row has the destination, a preview (rendered from the payload), approve/edit/reject, and history.
  - The pending style is dashed, so nothing looks sent before it is.
- **Health:**
  - A connector table with state, last success, cursor ("Slack through 10:41"), backlog, last error, and a **Re-auth** affordance per connector from brief 09:
    - Google: in-app;
    - Slack / Org62: "Open Terminal with `claude mcp login <name>`";
    - VDP: refresh, plus MFA instructions.
  - Tabs: Scan ledger (runs, windows, counts, cost) · Jobs (queued, running, retrying, dead-letter, with Retry) · Errors (an event log with acknowledge) · Spend (today and 7 days, by scanner and by model, against the budget).
- **Settings** (sections with a left index):
  - **Profile & role:** a role pack (SE IC / SE manager) and working hours.
  - **Priority policy** (R-UI-16):
    - weights sliders plus a plain-language rules list ("customer-facing beats internal", "manager asks within 24 h");
    - **Preview re-rank** shows the before/after Top 10, then **Apply**;
    - a version history with revert.
  - **Agent behavior:** voice samples and style, autonomy per action type (L0–L4), what counts as a task, watched channels/sources, and drafting style.
  - **Sending:** Draft/Send default, the dry-run switch, and verification.
  - **Budgets:** soft ($5) and hard ($15).
  - **Display:** density, theme, shortcuts cheat sheet.

## 13. Quick capture (R-UI-9)

- `c` anywhere opens a one-line capture modal: "Talk to product about NCE gaps + team's open questions".
- Enter saves instantly, and the item appears in Today with "enriching…".
- Enrichment arrives as **related-work chips**, each with a reason and accept/reject:
  - "Claude session 'NCE gaps notes' (Nov 4)";
  - "Doc 'NCE open questions' (Drive)";
  - "Slack thread in #team".
- The NBA then fills in, for example a drafted message to the PM with the doc attached.

## 14. Keyboard

The keyboard model follows brief 08 §3.2 exactly. Globals:
- ⌘K palette, ⌘J chat, `c` capture, `?` cheat sheet;
- `g h`/`g t`/`g w`/`g b`/`g d`/`g a`/`g l`/`g o`/`g s` to jump between pages (`g b` = Briefs);
- `[` / `]` to collapse the day column or the rail.

Lists:
- `j/k` to move, `1 2 3` to jump to a Now card;
- `Space` / `Enter` / `⇧Enter` to drill;
- `⌘↵` for the primary action;
- `e` edit, `a` accept, `s` snooze, `d` done, `n` not now, `z` undo, `x` select, `o` open source, `r` apply re-rank.

## 15. Mock mode (what "looks and feels right" is judged on)

- `CC_DATA=mock` (the default until the wiring wave) serves every `/api/v1/*` route from `src/mock/`.
- **The seed:** it loads `~/Library/Application Support/control-center/fixtures/seed.json` (real data, kept outside the repo) and falls back to the committed `src/mock/seed.example.json`, which uses placeholders.
- **The scenario clock (the mock must feel alive):** `src/mock/scenario.ts` replays timed events over SSE. A dev toolbar can play, pause and reset it. The events:

  | Time | Event | What it exercises |
  |---|---|---|
  | +20 s | A Slack reply updates NBA #2's draft | Update strip |
  | +40 s | The Claude session for card #1 goes `waiting` | Rail lane + promotion |
  | +60 s | An email you sent auto-closes a commitment | Closed for you |
  | +80 s | A deck edit moves a deliverable to in_progress | Drive signal |
  | +100 s | The Gmail connector breaks | Banner, stale marks, health dot |
  | +120 s | New requirements reopen a done task | Reopened |
  | +140 s | A re-rank becomes available | Pill |

- **Mutations in mock mode** update an in-memory store, so optimistic flows, undo, receipts and 409s can be exercised. A `?fail=1` query or a dev toggle forces errors to test rollbacks.

## 16. Acceptance for the mock

- Screenshots at **1280, 1440, 1920 and 2560** px for Today, Work, item sheet, Agents, Time and Health. Nothing in the Top 3 truncates, and no line runs past about 90 characters.
- From opening the app, the first meaningful action takes under 60 s, and the Top 3 plus their reasons are nameable within 10 s.
- Every panel has empty, loading and error states, reachable through the dev toolbar.
- Every action in §14 works by keyboard, and ⌘K lists it.
- The scenario clock runs end to end with no console errors.
