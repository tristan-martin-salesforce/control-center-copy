# 19. The last read twins: Today, Triage, the Time week (F4, R7 step 3)

The DataSource split left three read bodies twice, once per store, because their behaviour differed: `buildToday`
(`db/views.ts` and `mock/views.ts`, 86 % alike), `buildTriage` (the same two files) and `buildTime`
(`db/domains/time.ts`, `mock/domains/time.ts`). Each now lives once in `src/server/views/{today,triage,time}.ts` over
`ReadSource`, and both DataSources call it. Every difference is listed below with the rule that decided it. Where the
spec is silent, the Postgres behaviour wins, because it is what runs daily. What only one store can know stays a
capability that the caller passes in (`TodayReads`, `ClosedInputs`, `TimeWeekReads`). It is never a fork in the body.

Found and resolved: **Today 8 / 8, Triage 3 / 3, Time week 6 / 6, Work lists 4 / 4** (plus 7 points compared and
already the same, listed for the record). No difference needed a product decision.

## Today (`todayView`, `views/today.ts`)

| # | Difference | db | mock (before) | Decision | Why |
|---|---|---|---|---|---|
| T1 | Next meeting | skips tentative and unanswered invites | any upcoming meeting | **db** | UX: a tentative invite shows on the spine and never blocks time; the db comment says so |
| T2 | Quarter progress (logged hours) | `quarterTotal`: this fiscal quarter's logged rows | seeded base plus every logged row in the store, any quarter | **db** | EDGE-CASES rule 6 / TL-45 (one count map); the mock's Time week already used `quarterTotal`, so Today and Time disagreed in mock mode |
| T3 | A likely-done item in the stored Top 3 | the ranker's Top 3, then `topWithoutLikelyDone`: refill from the rest, the likely-done item leads the rest | filtered out before the slice and left at its own position in the rest | **db** (LD-1) | Same NOW cards in the common case; the db rule is the one Home's tests pin (`tests/home/looks-done.test.ts`) |
| T4 | Scanner pulse connector | `source === 'slack'` | `id === 'slack'` | **db** | A connector's id is not its source (the registry's ids can differ) |
| T5 | The ranker | `DbRanker.today` over Q1's stored order (ENGINES-core, Top 3 stability, `rerankReady`) | its own scorer inline (stored order, the 3 h promote rule, `pendingRerank`) | **capability** `TodayReads.rank` | The mock's ranker is the interim ranker (`db/rank.ts interimRanker`, the same one parity-reads gives the db), so the selection code is shared, not copied |
| T6 | ENGINES-core plan (spine slots, fit-ins, promises, capacity) | used when the ranker has one | no branch | **db body** | The view takes the plan when the ranker gives one. Without one it falls back to the seeded slots, the shelf rules and `TodayReads.capacity` (the CAPACITY engine; `mockCapacity` in the mock) |
| T7 | Closed for you: each close's Undo | Q6 map, looked up by the row id only | latest `item.close` audit entry not undone | **capability** `TodayReads.closeUndo` | Store-specific. The db's lookup now also tries the row's uuid, as Triage's always did (the two db pages disagreed) |
| T8 | Since-you-left digest, Triage count | passed in (the change sets; `buildTriage(model)`) | computed inside from the audit log and `buildTriage(store)` | **capability** `TodayReads.since`; the count comes from `triageView` in the body | Both computed the same thing. Only the audit source differs |

## Triage (`triageView`, `views/triage.ts`)

| # | Difference | db | mock (before) | Decision | Why |
|---|---|---|---|---|---|
| R1 | A missed opp's Org62 source | links the opp's `org62Url` when the app tracks the opp | label only | **db** | Tenet *Provenance on everything* |
| R2 | Pass order | suggestions first, then likely-done items | one pass in store order | **mock's single pass** | No visible effect: the two land in different groups, and each group sorts stably by `createdAt` |
| R3 | `suggestedIds` (Q9's ordered ids) | optional parameter | none | **dropped** | Dead since DEEP-1: every caller passed nothing (Q9's 100-row limit hid the oldest suggestions) |

Closed for you's Undo was already passed in (`ClosedInputs.undoOf`). The triage helpers (`TRIAGE_ORDER`,
`suggestionGroup`, `looksDoneTriageItem`, `closedTriageItem`) moved with the view.

## Time week (`timeWeekView`, `views/time.ts`)

| # | Difference | db | mock (before) | Decision | Why |
|---|---|---|---|---|---|
| W1 | Meetings lane | skips tentative and unanswered invites | every meeting not cancelled or declined | **db** | A tentative invite is not logged time (as T1) |
| W2 | Meeting ↔ activity row | by the meeting's calendar id (`source.externalId ?? id`) | by the app id | **db** | Activity sources carry the calendar id; on real data the app id never matches |
| W3 | Travel and onsite frames | meetings-lane time blocks join the Meetings lane | dropped | **db** | Onsite lane: time with the customer is never "focus" |
| W4 | Onsite chips | the stored onsite weeks (kv `cc.onsite.week/*`) | an in-memory map | **capability** `TimeWeekReads.onsite` | Store-specific; same filter and order |
| W5 | Suggestions for rows that need an opp | `contextOf` with the attribution engine's cache | `baseSuggestContext` with the mock attribution extras | **capability** `TimeWeekReads.suggested` | Both run `withSuggestions`; only the context source differs |
| W6 | Canvas progress | added after async loads, and only when a created canvas exists | sources passed every time | **capability** `TimeWeekReads.progress` (optional) | Same output: progress is null unless the canvas has been created. The db keeps its lazy loads (`withCanvasProgress`) |

## Work lists (`workListView`, `views/work.ts`)

`buildItems` was the last twin: `db/views.ts` ordered and counted what `DbWork.listItems` had filtered (account, opp
and initiative in SQL, the rest in memory), `mock/views.ts` filtered, ordered and counted in memory. The bodies after
the filter were already the same code. Now the view owns the filters, the tab rule, the order, the counts and the row
shape; the db passes the SQL's ids as `WorkReads.candidates`, a superset the view filters again (the mock passes
nothing). The spec: `ItemsQuery` and `ItemsPayload` (`contract/requests.ts`, `contract/views.ts`), the route summary
"Work list by tab + filters", UX.md's Work row ("What is open, and why?"), the Work page's filters
(`components/lists/url-filters.ts`). None of them settles a tie or an id form, so the db rule decided.

| # | Difference | db | mock (before) | Decision | Why |
|---|---|---|---|---|---|
| WL-1 | Whose items | SQL `owner_user_id = me` | every item in the store | **no filter in the view** | No visible effect: the db's read model already loads only the user's items (`loadWorkItems`), and the mock holds one user |
| WL-2 | Account, opp and initiative filters | the column against `uuidFor(id)`: a seed id and its uuid name the same row | the record's id, exactly | **db** | The view compares database keys (`refIs`), so the same link works on both stores |
| WL-3 | The filter query fails | empty list, every count 0, nothing said | (no query) | **view: filter in memory** | A failed narrowing must not change the answer. `candidates: null` is the mock's path, so the db shows the right list, only without the narrowing. Departs from the db, which hid a failure as "nothing open" |
| WL-4 | Order ties on Closed and Promises | none: equal close times (or ages) fell to the loader's order, `created_at, id` | the seed's insertion order | **db**, made explicit: `createdAt` | One order on both; captures were already last on both |

Compared and already the same (no change): the text filter (title, purpose and why, case-insensitive); source and
kind; what is open (a live state, `isLive`: a suggestion is in Triage, a dismissed or merged item in no tab); every
tab counted over the same filters, so the tabs show what the filters leave; no paging (`total` is the rows shown; the
contract has no page parameters); no persona gating in the list (stale marks go through `hydrateItem`'s D-55 rule on
both); the Assistant's `listItems` tool (the mock called `buildItems`, the db the route; both reach the view now).

What the SQL buys, honestly: `listItems` still reads the whole model (`WHOLE`: the Work list has no page scope yet),
so the candidates narrow what the view walks and hydrates, not what is loaded. The db now skips the query when no
account, opp or initiative filter is set (before, it fetched every item id on each call). Shrinking the load needs a
Work-list scope in `reads/scope.ts` (row windows by filter); that file is not this chunk's, so it is noted here, not
widened.

## Guards

- `tests/db/datasource/parity-reads.test.ts` already reads `getToday`, `getTriage` and `getTime` (this week and the
  week before) on both stores, again after the rows are reversed. It stays green (165 cases) and is now equal by
  construction. The Work lists add 11 `listItems` shapes to the 10 it had: every tab, each filter the Work page
  sends alone (account, opp, initiative, source, kind, q), filters on closed tabs, every filter at once, two
  structural filters together, and a search that matches nothing (187 cases).
- `tests/datasource/read-twins.test.ts` pins each decision on the mock, the side that changed: T1 to T4, R1, W1 to W3,
  WL-2, WL-3 (candidates only narrow), WL-4, the shared counts, and that the combined parity shape is not empty.
- `tests/datasource/layout.test.ts` pins `today` and `triage` in the views list, and that neither `db/views.ts` nor
  `mock/views.ts` keeps a read body (`build*`, `tabMatch`) of its own.
- No ui test asserted the mock's old behaviour, so none needed an edit.

No read twins are left. `buildItems` stays as an alias of `workListView` in `mock/views.ts` for the Assistant's
tool import (`mock/domains/chat.ts`).
