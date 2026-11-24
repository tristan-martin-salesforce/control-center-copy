# 24 · Visual QA of the post-2.0 surfaces (2026-11-21)

Builder `post-visual-qa`. Base `tmart2322/control-center-port-polish` at `f09d434` (SEC-10 closed). Mock mode on lane
port 4403 (`CC_DATA=mock`, the placeholder seed rebased onto Saturday 21 Nov, so the shots read ~09:0x). Each surface
was shot at 1440 in dark (the default) and light (`?theme=light`), 1280 where dense, and driven with Playwright
(scripts in the session scratchpad) for what a still shot can't reach: open dialogs, second clicks, Esc, where focus
lands, hover cards. States the seed lacks were made in the browser only (Playwright `route` rewrites of one GET:
memory entries, a queued session with a 62-line prompt, a thread with tool rows and image markdown, Work's page size
50 → 2); one in-memory `POST /outbox/releases` on the mock staged a release with no folder or channel. No fixture in
`src/mock/**` changed. Judged against UX.md, TENETS and the 18-ui-polish rules (plain words, one primary per card,
Undo on decisions, spacing scale).

Shots: `.shots/qa/before/` and `.shots/qa/after/` in the worktree (git-ignored). Names `s<n>-<what>[-light].png`.

Severity as in 18: **H** wrong idea or can't read it · **M** jargon, focus lost, clipped, misleading state · **L** cosmetic.

## Totals

| Severity | Found | Fixed | Left |
|---|---|---|---|
| H | 2 | 2 | 0 |
| M | 17 | 17 | 0 |
| L | 9 | 6 | 3 |

## 1 · Settings ▸ Budgets ▸ What the Assistant remembers

Shot: `.shots/qa/after/s1-memory-3-armed.png` (before: `before/s1-memory-3-armed.png`).

| Seen | Sev | Status |
|---|---|---|
| The block (and Receipts after it; Profile ▸ AEs I cover the same way) sat flush on the pane's left edge with Forget clipped at the right: blocks rendered after a Section had no gutter. | M | **Fixed** `c1a6224`: `.spane > .block` keeps the section's 32 px gutter. |
| Forget for good removed the row and its button; focus fell to the page body. | M | **Fixed** `c1a6224`: focus moves to the next entry's Forget, else the one before, else the list. |
| Empty, one, several: plain source lines ("Every thread · from your message in “Today”, Nov 5, 08:58"), a long excerpt truncates with the whole in its title, "the message it came from is no longer here" reads fine; Forget → Forget for good (danger) disarms on blur; light theme readable. | – | – |

Tests: `src/components/settings/__tests__/assistant-memory-qa.dom.test.ts`.

## 2 · Review prompt → Open in Claude (Agents, Home, Today, Details, thread pane, chat card)

Shot: `.shots/qa/after/s2-chat-pane-dialog.png` (62-line prompt, scrolled, from the thread pane).

| Seen | Sev | Status |
|---|---|---|
| Home ▸ Coming builds and the Details panel's Start in Claude: Not now / Esc left focus on the page. The launch disables (Coming builds) or swaps (Start in Claude → Open in Claude) the button you clicked, so the overlay's own restore found the body. | M | **Fixed** `ab92c20`: `LaunchReviewDialog` remembers the control clicked before it opened and, when nothing holds focus on close, focuses it or the first control where it stood. |
| Home and Today: "Preparing the Claude Code session…" stayed over the open review for its 4 s. | L | **Fixed** `ab92c20`: dismissed when the review shows. |
| The chat session card, reviewed: no line count, the prompt without its report-back tag (the dialog shows it), and "runs with your permissions" under the buttons, below the fold on a long prompt. | M | **Fixed** `ab92c20`: "The whole prompt · N lines", every character, the permissions line above Open in Claude (the card keeps its own sentence, "the Assistant wrote in this thread", which SEC-10 asked for). |
| Agents header popover: after Review prompt focus fell to the page (the form and its button were replaced) and Esc left it there; the title quoted the name ("“New Claude session”") where the dialog doesn't. | M | **Fixed** `169f359`: Not now takes focus (the dialog's safe default), Esc returns to Start in Claude; same title form. |
| Same copy and layout in the dialog everywhere (folder, "The whole prompt · N lines", the permissions line, Not now / Open in Claude); long prompts scroll inside (`max-h 50vh`); Esc closes. Light and dark fine. | – | – |
| A run just prepared reads **"Opening in Claude…"** on Agents while nothing has opened (it waits for Open in Claude since SEC-10). The text is the launch's `lastEvent`, written by both DataSources (`src/server/datasource/{mock,db}/domains/agents.ts`). | M | **Fixed** `05868ff` (post-QA leftovers): both DataSources write `PREPARED_LAUNCH_EVENT`, "Prepared: review the prompt, then click Open in Claude" (`src/server/datasource/types/agents.ts`); mock test and the launch parity test pin it. |
| Today's Start in Claude (`launchClaude`) can't be reached in the mock: the seed's only start_in_claude card already has a session, so it resumes on one click (correct). | – | Covered by `tests/today/launch-review.dom.test.ts`. |
| The Details panel's review of the seed's Beacon item shows "Package the Beacon app for Ravi… [cc:…]": the seed's `promptPreview` is longer than its link's `q`, so `fullPrompt` falls back to the truncated preview. | L | Left: mock data only (a real preview is never longer than the prompt). |

Tests: `src/components/agents/__tests__/launch-review-focus.dom.test.ts`, `start-popover-focus.dom.test.ts`,
`src/components/chat/__tests__/session-card-review.dom.test.ts`.

## 3 · Getting started

Shot: `.shots/qa/after/s3-claimed-after.png` (the card at 2/5 right after a claim; before: `before/s3-claimed-after.png`, 1/5).

| Seen | Sev | Status |
|---|---|---|
| Claiming a DC ticked the outcome on the server (2/5) but the sidebar card stayed at 1/5 until the window lost focus: the guide followed health, draft, chat, scans and jobs only. | M | **Fixed** `ffa64ff`: card and page follow `GUIDE_TOPICS` (adds deals, time, settings, onboarding). |
| Each outcome's button was a `<button>` inside a link (two tab stops, invalid nesting). | M | **Fixed** `ffa64ff`: one button that navigates. |
| On the DC path: a row just claimed on Missed opportunities showed **Undo** twice side by side. | M | **Fixed** `ffa64ff`: the secondary Undo only beside Open task. |
| The first-scan line before the scan finishes: "First scan: about $12.81–$20.33 (p50–p90), about 4 h. Past that it asks before it goes on." Placement and the five outcomes read well (one filled button: the first to do). "(p50–p90)" is statistics jargon on a first-run page, and Health ▸ Spend and onboarding use the same form; UX.md spells it so. | L | **Fixed** `077ad42` (post-QA leftovers): one helper, `usualCost` (`src/llm/spend/first-scan.ts`): "First scan: usually about $12.81, up to $20.33, about 4 h" on Getting started and onboarding (both through `firstScanLine`), "usually about $A, up to $B a day" on Health ▸ Spend; no p50/p90 in the UI; UX.md says so. |

Tests: `src/guide/__tests__/guide-live-qa.dom.test.ts`, `src/components/deals/__tests__/missed-one-undo.dom.test.ts`.

## 4 · Work ▸ Closed paging, the list's switchers

Shot: `.shots/qa/after/s4-closed-more-1280-light.png` (page size rewritten to 2: "Show 2 more · 4 of 6 shown").

| Seen | Sev | Status |
|---|---|---|
| Show more was `disabled` while loading, which dropped focus to the page every press. | M | **Fixed** `36ee3f9`: `aria-disabled` + `aria-busy` (the hook already ignores a second press). |
| On Closed (and Snoozed) the By when / By initiative toggle showed **both options struck through** (the kit draws a disabled option with line-through). | H | **Fixed** `36ee3f9`: no toggle on a flat tab. |
| A done row said its resolution three times: badge "Done by Raj", then "**Done by Raj** · by Raj Mehta · …". | M | **Fixed** `36ee3f9`: the why line leaves it to the badge (a dismissed row, whose badge only says Dismissed, keeps it). |
| Paging: appends under what is on screen, counts stay the payload's, the last page removes the row. The header's "4 items" counts rows loaded while the sentence says "6 closed". | L | Left: the keyboard hint's count (ListFrame), cosmetic. |

Outside the glob: `app/work/_list/{MoreRow,WorkPage,RowExtras}.tsx` (the surface lives there; smallest changes).
Tests: `tests/ui/work-closed-qa.test.ts`.

## 5 · Home one column with the panel open; Activity's Needs you

Shot: `.shots/qa/after/s5-home.png` (before: `before/s5-home.png`); panel open: `before/s5-home-panel-scrolled.png`.

| Seen | Sev | Status |
|---|---|---|
| Home's Needs-you panel had no bottom padding: the folded groups (▸ This week 11 · Deals 3 · Admin 10) sat on its border, panel open or not. | L | **Fixed** `b569a73`: `py-3`. |
| One column under ~900 px holds: card 1 takes the row, 2–3 share the next, the ribbon and the verb columns stack, the page scrolls. The why hover card opens on the click and covers the card while the pointer rests there. | L | Left: hover behaviour by design. |
| Activity: Needs you here is the first section under the tabs, inside the scroll, same rows and keys. The header sentence reads "6 rows, 1 use case and 3 use cases to add need you" (`needsYouSentence`, `src/engines/activity/needs-count.ts`). | L | **Fixed** `7e8d10e` (post-QA leftovers): "6 rows and 4 use cases (3 to add) need you", use cases named once, right for 0/1/many of each (`tests/engines/activity/needs-phrase.test.ts`). |

Tests: `tests/ui/home-needs-padding.test.ts`.

## 6 · Settings ▸ Sending ▸ Trusted sites for asset links

Shot: `.shots/qa/after/s6-hosts-edited.png` (a URL typed and normalised to `assets.example.com`, force.com removed).

| Seen | Sev | Status |
|---|---|---|
| Removing a site took its × with it; focus fell to the page (every ListEditor: Closing's lists too). | M | **Fixed** `3935174`: the chip that took its place, else the one before, else the add field. |
| The label sat mid-height beside the tall chip list. | L | **Fixed** `3935174`: `Row top`. |
| Autopilot off: "every VDP change waits for your Apply **or push**" (the word the polish pass retired). | M | **Fixed** `3935174`: "…waits for your Apply." The re-auth block's header comment said "Run refresh"; it names the button by its label, Re-auth VDP (the help line already did). |
| Add normalises a pasted URL to its host, duplicates are ignored, the edited row is marked and Save / Discard appear. | – | – |

Tests: `src/components/settings/__tests__/list-editor-focus.dom.test.ts`.

## 7 · The Assistant: untrusted text, the remember refusal, images

Shot: `.shots/qa/after/s7-chat-light.png`.

| Seen | Sev | Status |
|---|---|---|
| Nothing on screen said a result was other people's text: the `[untrusted … content]` line reaches only the model (ARCHITECTURE §7 says the tool row marks it). | M | **Fixed** `13655c1`: an expanded `<source>.search` / `<source>.read` row (slack, gmail, drive, calendar, org62, vdp, ledger) carries **others’ words**, its title saying it is read as information, never instructions. |
| The SEC-8 refusal showed as "✕ assistant.remember → Not kept (say it in your words)" in red, and the folded line "· 1 failed". A guard that held something for you is not a failure (UX "Raise a hand, never a red stop"). | H | **Fixed** `13655c1`: a summary ending "(say …)" (SEC-8's and SEC-9's refusals) is a neutral "–" row and not counted as failed. **Then** `a3a0e8a` (post-QA leftovers): the tool result carries `held: true` (contract `ChatSseEvent` tool-result and the stored `tool` part, additive), set where `remember` and `run reauth` refuse; the row reads the flag, the "(say …)" ending only for threads stored before it. |
| A markdown image vanished silently, and a linked image became an **empty, invisible link** (`<a href=…></a>`, still a tab stop). | M | **Fixed** `13655c1`: an image renders as its alt text (no link to the image URL); a link whose only content was an image keeps the alt text or shows its address. Nothing loads (SEC-4 unchanged). Also applies to the brief reader. |

UX.md: one bullet in the Assistant section. Tests: `src/components/chat/__tests__/tool-rows-qa.dom.test.ts`,
`markdown-images.test.ts`.

## 8 · The release draft rows with no Drive folder or channel

Shot: `.shots/qa/after/s8-outbox-panel.png` (before: `before/s8-outbox.png`).

| Seen | Sev | Status |
|---|---|---|
| The line read "Set the announcement channel first: (distributionAnnounceChannel in config/team.json)". | M | **Fixed** `612ed99`: "No announcement channel is set: add the channel’s id as distributionAnnounceChannel in config/team.json." (the folder the same way); the change line "not set (… in config/team.json)". |
| The Details panel for that item said **"✓ Ready to apply"** with Apply enabled (it would fail "Not sent: …"), and didn't say what was missing. | M | **Fixed** `612ed99`: pill "▲ Set up first", the line above the post, Apply and ⌘↵ off. |
| "no channel set" appears three times on the row (title, chip, line); the announcement lists above the upload although you apply the upload first. | L | **Fixed** `5c55578` (post-QA leftovers): said once, by the row's line; no chip, why part, title ("Announce Command Center v2.1.0") or change line ("not set") repeats it, the verb stays off, and the dispatch refusal points at the row ("Not sent: no announcement channel is set (the announcement’s row in the Outbox says what to set)"). The Outbox lists a release's upload above its announcement (`sortOutboxNewestFirst`, the pair at the newer one's place). |

Outside the glob: `src/outbox/adapters/release-handoff.ts` (two strings and two change labels) and the two outbox tests
that quote them. Tests: `src/components/detail/__tests__/release-missing.dom.test.ts`, `tests/outbox/release-*.test.ts`.

## Also

- ENG-5: the new tests pulled `src/engines/activity/overlap-flags.ts` into 58 test files outside the mock (bound
  55) through barrels; four imports now take their leaf (`8624ce4`): 54.
- The shared install at `kraken/node_modules` turned into a self-referencing symlink at 12:09 (not this lane); this
  worktree ran `npm ci` (no lockfile change) to finish the checks.
