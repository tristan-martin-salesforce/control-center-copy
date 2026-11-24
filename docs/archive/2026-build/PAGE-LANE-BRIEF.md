# Shared brief for page lanes (P1–P5, SWAP)

The orchestrator owns this file. Read it before your lane-specific brief.

## Read first (binding)

- `CLAUDE.md`, `docs/archive/2026-build/REQUIREMENTS.md` (R-UI-1…22), and **all of `docs/archive/2026-build/UI-SPEC.md`**.
- `docs/archive/2026-build/BUILD-PLAN.md`, for the builder rules.
- `docs/reference/CONTRACT.md` and `src/contract/**`.
- The latest entries in `docs/archive/2026-build/CHECKPOINTS.md`.
- Visuals: `~/Projects/control-center/docs/research/12-salesforce-brand.md` §6–8 and §10.
- Patterns: `~/Projects/control-center/docs/research/08-command-center-patterns.md`, the sections relevant to your pages.

## Building blocks you must use (all merged on main)

Don't re-create any of these. If something is missing, add it inside your own folders, or raise a blocker.

### Primitives: `@/ui`

Includes:
- `Button`, `IconButton`, `Icon` (SLDS sprites), `StatePill`, `SourceChip`, `ConfidenceWord`, `EffortSplit`, `StartBy`, `EntityChip`;
- `Tooltip`, `Popover`, `Menu`, `Dialog`, `SideSheet`, `Tabs`, `SegmentedToggle`;
- `Skeleton`, `EmptyState`, `PanelBoundary`, `StaleMark`, `Banner`, `InlineStatus`;
- `ListContainer`, `ListRow`, `ListGroupHeader`, `ObjectTile`, `LetterAvatar`, `PanelError`, `ChangedElsewhere`, `Kbd`, `KbdHint`.

Helper hooks: `usePanelState(id, …)` follows the dev toolbar's forced states; `useNow()` and `useTimeZone()`.

### Client

- **Data:** the typed `api()` and `useApi(routeKey, input)` from `src/client/**`. `queryKey()[0]` is the live topic, and `src/client/live.ts` invalidates by topic over SSE.
- **Mutations:** `useOptimisticMutation({route, optimistic, topics, rebase, toast})`, then `mutate(...)`. Use `versionOf(id)` for `ifVersion`.
- **Autosave:** `useAutosave(value, save, {debounceMs})`, which returns `{bind, status}` and renders `<InlineStatus>`.
- **Keyboard:** `useKeyBinding`, `useKeyScope`, `useListKeys({scope, ids, activeId, onActiveChange, onOpen, onExpand, onOpenPage, onPrimary, actions})`.
- **Commands:** `useCommands([...])` and `useFocusedCommands({label}, [...])`, so every page action is also a ⌘K command with its shortcut.
- **Toasts:** `toast({title, tone, key, undo:{auditId}})`.
- **Resume:** `useResumeSelection`, `useResumeSheet`, `useResumeScroll`, `useResumeExtra`.

### Shell

- `<NavStrip>` fills the nav bar's right side.
- `<RailPanel id label icon count>` is a rail tab below 1920 px and its own column above that.
- `useShell()` gives you `dayCollapsed`, `focusChat` and `registerChatFocus`.

### Domain components: `@/components/domain`

Read `src/components/domain/index.ts`, and the kits at `app/dev/kit/domain/page.tsx` and `app/dev/kit/domain/today/page.tsx`, for exact props and callbacks. Wrap pages in `<DomainClock now={…} tz={…}>`.

- `NbaCard`, `WorkRow`, `WorkList`, `WorkGroup`
- `DaySpine`, `DayRibbon`, `HeaderStrip`
- `StatusRail`, `RailLane`, `Shelf`, `FitInRow`, `PromiseRow`
- `ReceiptCard`, `ProposalDiff`
- `AgentRunRow`, `BriefHighlightCard`, `BriefSummary`
- `ConnectorRow`, `ActivityRow`
- `ResolvePicker`

### Chat: `@/components/chat`

`ChatProvider`, `ChatDock`, `ChatTabPanel`, `AskBar`, `setChatContext` / `useChatContext({kind,id,label})` (`kind` must be a contract EntityType), `focusChat`. Every page sets the chat context for its focused entity.

### Composer: `@/components/composer`

FE-1c is building it, so it may not be merged yet. Its exports are `Composer`, `ComposerInline`, `ConfirmSendDialog` and `SendCountdownToast`. If it isn't on main yet, put a clearly-named `TODO(FE-1c)` stub behind a single import in your folder.

### Libraries

- `src/lib/compose` (`renderPreview`, `payloadFor`). Any HTML you inject must go through `isomorphic-dompurify`.
- `src/engines/**` (pure; don't call them from the client).

## Behaviour rules that apply on every page

- **Saving and feedback.** UI-SPEC §8 is the save model per surface, and §9 is the feedback matrix. Use one channel per event. Anything that needs action must persist; never use a toast alone for it.
- **Optimistic and live.** Every mutation is optimistic, with rollback, inline errors and 409 handling (UI-SPEC §10). Live updates never reorder rows under the cursor; new items get a "n new ↓" marker.
- **Panel states.** Every panel has empty, loading and error states, and is wrapped in a `PanelBoundary`. Items affected by a broken connector show a `StaleMark`.
- **Keyboard.** Every action is reachable by keyboard and by ⌘K (UI-SPEC §14). The drill model is `Space` to expand, `Enter` for the side sheet, `⇧Enter` for the full page. Esc restores focus.
- **Layout.** The frame is a cockpit: the page never scrolls, only its panels do. Use container queries, and support 1280 to 2560 px wide.
- **Styling.** Use tokens only; no raw hex. Keep one primary action per view and stay within the gradient budget.

## Data and screenshots

- The mock loads the **private real seed** automatically (`~/Library/Application Support/control-center/fixtures/seed.json`). Use it for your visual review, because judging against real data is the point. Screenshots go in `.shots/`, which is git-ignored. **Never commit screenshots or real data.**
- Tests must use `src/mock/seed.example.json`, which the vitest config already sets.
- Use the scenario clock: `npm run shot -- <route> --scenario <seconds>`, or the dev toolbar. It shows live behaviour such as an update strip, a waiting session, auto-closes, a broken Gmail, a reopen, a re-rank, and loop-back.

## Verify (required)

1. Run `npm install`, then `npm run check`. It must pass.
2. Run `PORT=<your port> npm run dev:web`.
3. Take screenshots at **1280, 1440, 1920 and 2560**. **Read every PNG** and critique it against UI-SPEC §1 and §16 and brief 12. Iterate at least twice.
4. Run a Playwright smoke script, kept in your scratchpad, covering:
   - the main keyboard flows;
   - one optimistic mutation plus undo;
   - one forced error (`/api/v1/dev/fail`);
   - the scenario events relevant to your pages;
   - zero console errors.
5. Kill the server.

## Rules

- Stay in your owned paths.
- No external calls, and never send anything.
- Don't change the contract, tokens, `@/ui`, or the domain, chat or composer components. Raise a blocker instead, or, for small display needs, wrap them in your own folder.
- Commit with conventional messages ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Return `{chunk, status, branch, sha, files, verify, screenshots, blockers, notes}`.
