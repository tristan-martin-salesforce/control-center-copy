# 03 · Scanner quality: recall, closure, resolution-agent design (lane SCN)

Reviewer: SCANNER-QUALITY. Read-only. Scope: owner's ask #2 and the correctness half of #3. Cost points go to the LLM-COST lane and get one line each here. Line numbers are from the tree at `3533cb6`. Nothing here was run against live data. The live DB isn't on this machine, so every claim about magnitude is marked unverified.

## 1. Summary

1. **There are two closers with two rule sets, and neither has the facts it needs.** The completion pass (`src/scanner/completion/`) sees only messages that arrived *since its last check*: up to 6, with no thread history, and the asker's "got it, thanks" filtered out. The Settle pass (`src/engines/settle/`) sees the whole conversation, but only Slack, Gmail and Calendar: no Drive, Org62, VDP or session state. The deterministic tests designed for closure (`reply`, `email_sent`, `session` signals and `closure_kind`) are never produced in production. Every close depends on a model call.
2. **User-correction rules are inconsistent.** Settle never closes an item the user has *touched in any way*. That includes accepting it from Triage, snoozing it, or setting its account or due date. The closure machine, meanwhile, has no guard at all and can re-close an item the user reopened. The first rule over-blocks; the second conflicts with *tenet: Suggest, then learn*.
3. **A wrong close becomes permanent.** When the asker chases ("that link doesn't open"), DUP-1 matches the closed item and attaches the chase as `context`, which never reopens it. The `reopenOnFollowUp` setting exists in the UI, but no code reads it.
4. **The biggest recall hole is Slack channel threads.** A reply addressed to me in a thread I'm in, without an @-mention, is never fetched. The inbox searches cover DMs, mentions and my own messages. Thread reads are capped at 5 per run and only on narrow triggers. A related hole: asks past character 1000 of a long message are cut at ingest.
5. **"Why wasn't X found" is answerable; "why didn't Y close" is not.** `not_done` verdicts and Settle `leave` decisions are not stored. I propose a single resolution check: a deterministic pre-fetch pack of about 1.5 K tokens, deterministic rules first, a tool-less Haiku call, a narrow Sonnet escalation, and one `closure_checks` row per decision. It comes with a CI-able eval harness built on `sample-data` and a cassette fake model.

## 2. How it works today

### 2.1 Life of an item

```
SOURCES
 Slack (traversal: Haiku calls slack_search/read_thread; REC-1 records every result)   src/llm/slack-rec.ts
 Org62 (traversal, REC-2) · Gmail/Calendar/Drive/Gemini/Claude (deterministic fetchers) src/connectors/**
   │ plan · cadence · precheck · first-scan ramp                    src/scanner/runtime/{scanner-runtime,cadence,first-scan}.ts
   ▼
PROMPT  system = _scanner-common.md + scan-<src>.md | context pack (≤60 open items, ≤25 initiatives, aliases)
        user   = Run block ({{window.*}}, me, scan prefs) + prefetched items (bodies ≤1500 chars)      src/llm/skill-loader.ts:140-292
        tools  = the source's read tools (allowlist) + cc_* (record, find_candidates, link, propose, flag, coverage, finish)
   ▼
STORE   cc_record_source_items → source_items (+source_item_refs)                  src/scanner/store-db.ts:905-1018
        cc_find_candidates → token/people/thread/file scores                        store-db.ts:1094-1171
        cc_propose_item → proposalGate (NOT-MINE, group asks, catch-ups)           src/llm/cc-tools/handlers.ts:130-158
                        → S4 key / DUP-1 dedupe → work_items open|suggested (DEEP-1/PAST-1 → Still needed?)  store-db.ts:1255-1389
        cc_link_evidence → work_item_evidence (DLV-1 attachment → Sure) → recordNewInfo → `reevaluate`   store-db.ts:1175-1253
   ▼ Slack only: triage pass (triage-slack.md, batches of 10, ≤12 batches) → `unsure` → Sonnet       src/scanner/triage/slack-triage.ts
   ▼
PROJECT work-accounts (account from title+purpose text) · calendar/sessions/time                  src/projections/run.ts, work-accounts.ts
RANK    priority run → Home lanes; read-ins (Sonnet, live tools) on direct asks / top-5 / prep     src/engines/priority, src/llm/readin
   ▼
CLOSE   completion.check after each scan: candidates.ts (deterministic) → check-completion.md (Haiku, ≤6 items/call)
          → gateVerdict → `done_check:` evidence (Sure | Likely | progress)                         src/scanner/completion/pass.ts
        settle.check every 10 min: load-db.ts pack → settle-item.md (Haiku) → Sonnet if unclear → policy.ts → settleApply
        reevaluate: closure/machine.ts applySignal → done (Sure, L4 "Closed for you · Undo") | likely_done | in_progress | reopen/sibling
   ▼
UNDO    change-set Undo; Triage ▸ Closed for you; a user Undo counts as "reopened" for Settle only (select-db.ts:80-84)
```

### 2.2 Where judgment sits

| Step | Deterministic (code) | Model |
|---|---|---|
| What to fetch | Scopes (`scope-catalog.ts`), windows, cadence, cursors, Gmail/Drive/Calendar/Gemini listing, the Slack precheck's "No results" | Slack: which threads to open (≤5), when to page; Org62 queries |
| Record | REC-1/REC-2 parse every tool result; hashes, dedupe keys, redaction (`handlers.ts:175-197`) | Gmail/Drive/etc. agents only when a sourceItemId is missing |
| Is it an ask of me? | `toMe` flags, NOT-MINE, group-ask gate, pleasantry/trivial filters, TRI-2 addressee | **Model** (traversal agent + triage pass + Sonnet escalation) |
| Where does it belong? | `findCandidates` scores; DUP-1 dedupe; reconcile retries | **Model** picks link vs propose vs flag |
| Account/opp | `Matcher.resolve(title+purpose)` (`work-accounts.ts:29`) | (skills may pass `accountId`, but rarely do) |
| Is it done? | Candidate selection, DLV-1 attachment upgrade, policy guards (open loop, upcoming meeting, cut-off) | **Model** twice (check-completion, settle-item), Sonnet for "unclear" |
| State change | Closure machine, settle policy, locks | none |

## 3. Findings

**SCN-1 (major): Slack channel-thread replies to me are never fetched (recall).**
- **What the code does:**
  - The inbox runs S1 (DMs/MPIMs not from me), S2 (`<@me>` mentions) and S3/S4 (my messages) (`skills/scan-slack.md:41-44`).
  - Scope (d), "threads I'm in", is only opened under §3's triggers, at most 5 per run. The open-item thread trigger fires only in `head`/`backfill` modes (`scan-slack.md:73-77`), so incremental polls never re-read a thread.
  - Triage's "thread I'm in" set is built only from messages recorded *in this run* (`src/scanner/triage/slack-triage.ts:194`).
  - Reconcile's stale-active re-reads only threads of open items, nightly, at most 10, and only after 6 h of quiet (`src/scanner/reconcile/reconciler.ts:305-327`).
- **What gets missed:** "can you send me the v2?" posted under my channel message, the asker's chase, a `requirements_change`, and "PERSON already sent it" (the `resolved_by_other` fact Settle needs). This affects both recall and closure.
- **Why it matters:** the owner's "it's not finding things". Customer and deal channels are where SE asks live.

**SCN-2 (major, tenet conflict): the closure machine re-closes items the user reopened.**
- `applySignal → completion()` auto-closes on any Sure completion (`src/engines/closure/machine.ts:194-232`). It checks no reopen or correction history. `reopenedCount` is only incremented (`:289`), never read.
- After an Undo, the next "done" message in the thread closes the item again.
- Settle does have the guard (`src/engines/settle/policy.ts:94`).
- *Tenet: Suggest, then learn* ("it never overrides a correction: an item you reopened or kept is never closed again"). Today one of two closers honours it.

**SCN-3 (major): Settle's "touched" rule over-blocks.**
- `userTouched` = any user transition or *any* user change set on the item (`src/engines/settle/select-db.ts:76-77,92`). It turns every close into an ask (`policy.ts:121`).
- Accepting a Triage suggestion is such a change set (`src/server/datasource/db/index.ts:932-935`). So are snoozing, editing a due date, setting an account (time logging), or adding notes.
- Result: every item the user ever triaged or tidied needs a "Looks done" click forever. The tenet only asks that "reopened or kept" items stay open.
- This compounds with the reeval watermark. Completion evidence that arrived while an item sat in `suggested` is consumed with no effect (`machine.ts:520`). It is never re-applied after Accept (`src/server/datasource/db/closure.ts:400-401`), and the completion pass only looks at newer messages.

**SCN-4 (major): a chase after a close is swallowed (DUP-1), and `reopenOnFollowUp` is dead.**
- `conversationDuplicate` matches closed items whose origin is within 14 days in the same conversation, from the same person, with ≥2 shared title words. New evidence on them is written as `context` (`src/scanner/store-db.ts:1286-1291,1391-1415`).
- `context` never moves state (`src/engines/closure/signals.ts:14`).
- The skill's alternative, a `contradiction` with `requirements_change:` (`scan-slack.md:113`), only fires if the model chooses to link instead of propose.
- `ClosingSettings.reopenOnFollowUp` (`src/contract/settings.ts:484`) has no consumer outside the settings UI (`src/components/settings/ClosingSection.tsx:174`).
- Settle never looks at `done` items (`select-db.ts:18`). A wrong close plus "that link doesn't open" therefore stays closed. This is the worst precision failure, because nothing surfaces it.

**SCN-5 (major): the deterministic closure tests exist on paper only.**
- **Unproduced signal types:**
  - `ReplySignal`, `EmailSentSignal` and `SessionSignal` are defined (`src/engines/types.ts:349-385`), and the machine handles them (`machine.ts:450-507`).
  - But the reeval pass builds signals only from evidence rows (`closure.ts:415` → `signalFromEvidence`, `signals.ts:84-108`).
  - The only `applyClosureSignal` callers are tests (`tests/be1b/integrate1.test.ts:167-208`, `tests/bereeval/reevaluate.spec.ts:432`).
- **`closure_kind` is never written:**
  - The scanner's insert omits it, so it defaults to `manual_only` (`src/db/migrations/0001_init.sql:2204`; `store-db.ts:1338-1349`).
  - It is read in only two dead branches (`machine.ts:459,489`).
  - `sample-data` shows `reply_in_thread`, `email_sent` and `org62_readback` values. That is synthetic data and doesn't match production.
- **Consequences:**
  - D-26's "auto-close reply tasks (deterministic)" (`docs/DECISIONS.md:51`) is not implemented.
  - Session reasons `blocked_on_me:` (`skills/scan-claude-sessions.md:71`) and hand-off reasons `handoff: to PERSON` (`scan-slack.md:116`) are produced but never parsed. A waiting session never moves its item to `waiting_on_me`, and a Slack hand-off never sets `handed_off`.

**SCN-6 (major): the completion pass is starved of context.**
- **Narrow input:** candidates are only sources first seen or edited after the item's last check (`src/scanner/completion/candidates.ts:215`), at most 6 (`:227`). The prompt carries the ask plus those lines, not the thread since the ask.
- **Asker confirmations are dropped:** the Slack pleasantry filter removes "got it, thanks", "perfect, thanks!" and similar (`candidates.ts:198-220`). The skill counts an asker confirmation as `done`/`confirmed` (`skills/check-completion.md:41`).
- **Sure is narrow:** it needs `basis: delivered`, ≥ 0.8, a strong relation (same thread/DM/email thread) and my own message (`pass.ts:149`).
- **So these become "Likely done · Confirm" at best:**
  - a Slack ask answered by email;
  - a deck sent in another DM;
  - a meeting booked;
  - an asker's thanks after I delivered elsewhere.
- **Other gaps:** Drive never closes (`machine.ts:473`, and the skill says "a file edit alone is never done"). Notes, Org62 and sessions are excluded from candidates (`candidates.ts:23`), on the premise of "their own signals", which (SCN-5) mostly don't exist.

**SCN-7 (major, unverified on live data): Settle can starve the newest items.**
- Selection orders by `created_at` ascending, limit 600 (`select-db.ts:35,57`).
- A pass stops at $1 (`src/jobs/handlers/settle.ts:265`). A partial pass keeps the old watermark (`:323`).
- Every `still_yours`, plus everything under 0.6, escalates to Sonnet (`src/engines/settle/run.ts:37`).
- Once a 10-minute pass hits its cap, the next pass re-selects the same oldest items first, so the newest asks are the ones never judged.
- *Cost:* escalating every `still_yours` and re-judging an item on every new DM message are the two Settle cost drivers (LLM-COST lane).

**SCN-8 (major): resolution context has no record, file or session state.**
- `loadSettleRaw` reads Slack conversation lines, Gmail threads, cross-DM lines, FTS hits and calendar events only (`src/engines/settle/load-db.ts:114-271`). There are no Drive revisions, Org62/VDP read-backs or Claude session status.
- Yet `settle-item.md` tells the model to "judge whether the record still shows the problem" for record-derived tasks.
- The model can't see that, so those items fall to `gone_quiet` or `still_yours`. (VDP and DC gaps do close deterministically elsewhere: `docs/EDGE-CASES.md` DC-01, VD-10, VD-20.)

**SCN-9 (major): asks past character 1000 are lost.**
- Every agent- or REC-recorded excerpt is cut to 1000 characters (`src/llm/cc-tools/handlers.ts:215`), although `source_items.body` holds 60 K (`store-db.ts:957`).
- The ramp counted 62 cut messages (`docs/ui/FIRST-SCAN-RAMP.md` §8 minors). Settle got a cut-off hint, but triage and the completion check still read the truncated text.

**SCN-10 (minor, unverified): Slack index lag can skip messages for good.**
- `window.afterUnix` overlaps only 120 s (`src/llm/skill-loader.ts:206`), and `window.to` is "now".
- A precheck "No results found" moves the cursor (`src/scanner/precheck/slack.ts:1-6`).
- Reconcile's coverage-gap listing exists only for deterministic fetchers (`reconciler.ts:154-163,332-335`). A message indexed more than 2 min late falls between windows, and the ledger says it was covered.

**SCN-11 (minor): Gemini next steps parse fragilely.**
- The parser requires a heading that is exactly `Next steps` and checkbox lines `- [ ] [Name]` (`src/connectors/google/gemini-notes.ts:56-61`).
- The sample notes use `## Suggested next steps` with `- [Name] …` and no checkbox (`sample-data/tables/source_items.json:51`). On that shape the parser returns 0 steps, and `hasNotes` is still true from the summary. The failure would be silent.
- A first-name-only assignee never matches a user who has a full name (`gemini-notes.ts:37-45`).
- Notes are polled for 120 min after the meeting ends (`src/connectors/google/calendar.ts:27`). I could not verify which format the real Gemini produces today: the fixture `tests/fixtures/scanner/gemini/notes.md` uses the checkbox form.

**SCN-12 (minor): some real ask channels are filtered as noise.**
- Gmail's bulk regex (`no-?reply|notifications?@…`) puts Google Docs "assigned you an action item" and comment mentions into skip rule 4.1 (`src/connectors/google/gmail.ts:45`; `skills/scan-gmail.md` §4.1). No code handles those mails.
- Claude sessions: a live session that ends a turn is `idle` (`src/connectors/claude/status.ts:98`). An unlinked change to an idle session never reaches the model (`src/connectors/claude/sessions.ts:141-143`). "PR is ready, please review" sits unseen until the terminal closes.

**SCN-13 (minor): Drive refs are stored in two formats.**
- Slack and agents write `drive:<ID>` (`src/connectors/slack/parse.ts:195`).
- `upsertItem` stores a ref as `drive_file` only when it matches `^[A-Za-z0-9_-]{15,}$` (`store-db.ts:185,1012`), so `drive:<ID>` lands as `url`.
- `workItemsByFile` joins only `kind = 'drive_file'` (`src/projections/run.ts:1570`), and `findCandidates` compares raw strings (`store-db.ts:1131`). The completion pass normalizes (`candidates.ts:43-52`).
- The "same file" join therefore works in one place and silently fails in the others. Not verified on live rows: sample-data `url` refs are full URLs.

**SCN-14 (minor): DUP-1 can merge two different deliverables.**
- `sameDeliverable` needs 2 shared title words covering half of the shorter title (`src/scanner/propose-rules.ts:48-56`).
- It excludes only the origin author's name (`store-db.ts:1408`). For my commitments, that's *my* name, so the counterpart's name counts.
- "Share ACME deck with Bob" and "Review ACME deck for Bob" in one DM merge on {acme, deck, bob}. The second deliverable disappears into the first (and, if the first is closed, into `context`, per SCN-4).

**SCN-15 (minor): entity resolution ignores the evidence, and learned rules don't feed back.**
- `matchWorkItemAccounts` resolves from title+purpose text only (`work-accounts.ts:29`).
- It ignores signals the item's own evidence carries:
  - the customer channel's account map (`accountHints` in source meta, `slack-rec.ts:151-156`);
  - sender and attendee domains;
  - Org62 ids in text.
- `proposeItem` takes only an explicit `accountId` (`store-db.ts:1293-1296`).
- `mapping_rules` (32 sample rows, `domain_to_account` with `hit_count`) is never read or written by any code in `src/` (only the events topic, `src/server/events/topics.ts:88`).
- Settle's `corrections` input is always empty: no producer exists (`src/engines/settle/prompt.ts:38`). "One-click corrections become rules" (*tenet: Suggest, then learn*) is unbuilt for both mapping and closing.

**SCN-16 (minor): dead or misleading knobs.**
- `oldAskDays` is not read; the threshold is hard-coded at 30 (`src/engines/still-needed.ts:16`).
- The `auto_close_allowed` column defaults to false but is never mapped into `ClosureItem` (`closure.ts:59-86`), so the machine treats it as allowed (`machine.ts:207`).
- `loadSettleUser` takes the first active user's name and timezone, not the job's (`load-db.ts:401-404`).
- Triage drops lines over 12 batches and never revisits them (`slack-triage.ts:267-268`).
- Read-ins discover "already answered" (`skills/readin-ask.md:43`), but nothing turns that into a closure hint.

**SCN-17 (major, observability): closure decisions are mostly invisible.**
- **What isn't stored:**
  - Completion `not_done` verdicts and their reasons. By design, logs carry counts only (`pass.ts` header).
  - Settle `leave` outcomes. Only non-leave entries reach `settleApply` (`settle.ts:300-303`), and `jobs.result` holds counts.
- **What the scripts answer:**
  - `scan:trace` / `scan:explain` / `scan:report` answer source-side questions well (`scripts/scan/explain.ts`, `src/scanner/trace/queries.ts`).
  - There is no `--item` mode. Nothing in the UI shows "last checked at, verdict, which gate blocked it, next check when".
- *North star: Legible.*

## 4. Recommendations

Effort: S < 1 day, M 1–3 days, L > 3 days. The dependency lane names are guesses at sibling lanes: LLM-COST, DATA-MODEL, UI, TESTING.

| # | Recommendation | Effort | Depends on | Migration / compat |
|---|---|---|---|---|
| R1 | **One correction rule, used by both closers.** `mayAutoClose(item)` = not user-reopened since its last close, not "Kept" or "Not done", not in the user's ask-first lists. Drop the generic `userTouched` (keep it only for title/kind edits, if at all). Compute it once (the select-db.ts SQL) and pass it into `ClosureItem` so `machine.ts:207` honours it (fixes SCN-2, SCN-3). | S | none | None: derived from `work_item_transitions`/`change_sets` |
| R2 | **Follow-up after a close reopens.** In DUP-1, when the match is closed by the engine within the reopen window and the new origin is from the asker addressing me, write `contradiction` with `follow_up:` and let the machine reopen (it already does, `machine.ts:399-406`). Wire `reopenOnFollowUp`. Add `done` items closed by the engine in the last 14 days to Settle's selection when a new line lands in their conversation (SCN-4). | S | none | None |
| R3 | **Deterministic closers first** (the D-26 intent). At proposal, set `closure_kind`: Q&A or reply-type ask → `reply_in_thread`; deliverable → `asset_delivered`; Org62/VDP-derived → read-back; session-launched → `claude_session_completed`. Emit `ReplySignal`/`EmailSentSignal`/`SessionSignal` from the store when my message lands in the ask's DM, thread or email thread after the ask (the `deliveredWith` query, `store-db.ts:1205-1222`, already does the join). Parse `blocked_on_me:` and `handoff:` in `signalFromEvidence` (SCN-5). | M | DATA-MODEL (no schema change; fill an existing column) | One-time backfill: `update work_items set closure_kind = …` by kind/origin, dry run first |
| R4 | **Merge the completion pass and Settle into one Resolution check** (design below): one skill, one pack builder (extend `load-db.ts`), one trigger, one ledger table (SCN-6, 7, 8, 17). | M–L | LLM-COST (model tiering), UI (panel) | New table `closure_checks` (additive migration). Keep `done_check:`/`settle:` reason prefixes readable. Retire `completion.check` after one release of shadow mode |
| R5 | **Slack thread follow-through, deterministic.** Each inbox poll re-reads (code, not model) up to 10 threads where I posted or was mentioned in the last 14 days and whose recorded replies are older than the poll window. Use `slack_read_thread` with `oldest = last recorded ts`, which is already allowlisted. Have REC-1 record replies so triage sees them. Lag `window.to` by 3–5 min and widen the overlap to 10 min, since dedupe absorbs repeats (SCN-1, SCN-10). | M | LLM-COST (extra tool calls; reads are not tokens if done in code via the relay; if only `claude -p` can call Slack MCP, the cost is one Haiku relay per batch) | None |
| R6 | Store excerpts up to 4000 chars, clip in prompts per use. Keep the 1000 cap only where token cost matters (SCN-9). | S | LLM-COST | New items only; old bodies can't be recovered without a rescan |
| R7 | **Candidate quality.** Keep an asker's acknowledgement when it follows a `fromMe` line, tagged `ack`. Include notes, sessions and Drive revisions as candidates with their own relation (SCN-6). | S | R4 | None |
| R8 | Settle/Resolution selection: newest activity first, a per-item `checked_at` so partial passes advance, and "nothing new since the last verdict → no call" (SCN-7). | S | R4 | None |
| R9 | **Observability**, detailed in 4.2. | M | UI | Additive table |
| R10 | **Eval harness**, detailed in 4.3. | M | TESTING | None |
| R11 | Gemini parser: heading regex `^(#{1,3})\s*(suggested\s+)?(next steps\|action items)\b`, optional checkbox, first-name match when unique among attendees. Add a Health counter "notes with 0 parsed steps" (SCN-11). | S | none | Rescan of Gemini notes is cheap ($0.18 in the ramp) |
| R12 | **Entity resolution from evidence, plus learned rules.** Order: channel map → `mapping_rules` (domain, sender, channel) → Org62 ids in text → title text. Write a `mapping_rules` row when the user sets an account on an item whose origin carries a domain or channel, and bump `hit_count` on use. Populate Settle's `corrections` from the last 10 user reopens/keeps (reason class + one line) (SCN-15). | M | DATA-MODEL (time-logging lane uses the same matcher) | Table exists; no migration |
| R13 | Normalize Drive refs at write (`normFileRef` in `upsertItem`) (SCN-13). | S | none | `update source_item_refs set kind='drive_file', value=substr(value,7) where value like 'drive:%'`, with a dupe-safe `on conflict` |
| R14 | Read-in → closure hint: add `alreadyAnswered: {cite}` to `readin_finish`, stored as `completion`/`likely` evidence with `readin:` prefix (SCN-16). | S | none | Additive optional field |
| R15 | Small fixes: wire `oldAskDays`; drop or wire `auto_close_allowed`; `loadSettleUser(ctx.userId)`; Gmail rule for Docs "assigned you" / comment-mention mail (an ask of me with the doc as `fileRef`); Claude idle + unlinked + quiet ≥ 30 min → model; DUP-1 excludes the counterpart's name for commitments and requires the deliverable noun to match (SCN-12, 14, 16). | S each | none | None |

### 4.1 Resolution agent for a cheap model (answers Q4)

**Principle:** the cheap model should never search. Code builds a complete, small, ordered pack, and the model answers one question about it. Tools are a fallback, at most one request per item.

**Trigger (code).** An item is checked when any of these happens:

1. new non-engine evidence;
2. a new line in its conversation (thread, DM or email thread);
3. a new message from me to the asker anywhere;
4. a Drive revision by me of a referenced file;
5. a linked session or read-back changing state;
6. its due date or linked meeting passing;
7. 7 days without a check (the gone-quiet sweep).

Otherwise it is skipped: no call. Deterministic rules run first and can decide without a model:

| Rule | Decides | Confidence |
|---|---|---|
| D1 my reply in the ask's DM/thread after the ask carrying the asked file/link (`deliveryMatch`) | done | Sure |
| D2 kind `ask` whose title is a question ("Answer…/Confirm…/Reply…"), and my substantive reply (not a promise pattern from R7, ≥ 12 words or a link) in the same conversation, with no later chase by the asker | done | Sure (`reply_in_thread`) |
| D3 a read-back shows the record fixed (Org62 DC, logged Event, VDP field) | done | Sure (exists for VDP/DC; extend to items) |
| D4 a linked session done with a PR/URL in its last message | done | Likely |
| D5 asker's last line after mine is an acknowledgement, and nothing since | done | Likely, or Sure combined with D1 |
| D6 nothing new since the last verdict | skip | none |

**Context pack (code, read from Postgres, no live calls), about 1.2–2.5 K tokens:**

| Block | Content | Cap |
|---|---|---|
| `item` | kind, title, purpose, due, status, firstSeen, asker, account/opp names | 1 |
| `ask` | full origin text (from `body`, not the 1000-char excerpt), at, where | 1 line, ≤ 1500 chars |
| `before` | lines just before the ask, same conversation | 4 |
| `after` | every line after the ask in the same conversation, oldest first; long ones keep the first 6, the last 6, and mine plus the asker's in between | 16 |
| `mine_elsewhere` | my messages/emails to the asker or naming the title keywords since the ask | 5 |
| `asker_elsewhere` | the asker's messages to me since the ask | 3 |
| `files` | Drive revisions by me of referenced files or files whose title shares 2+ keywords, with the digest's "changes" line | 3 |
| `events` | meetings with the asker or on the topic, from 1 day before the ask to 2 days ahead, with passed/response | 4 |
| `record` | for record-derived items: current field values vs expected (Org62/VDP read-back rows) | 1 |
| `session` | linked Claude session status + last 300 chars | 1 |
| `hints` | computed: myReplyAfterAsk (min), replyHasLinkOrFile, askerAckAfterMine, askerChasedAfterMine, lastWriter, duePassed, meetingAhead, rulesFired (D1–D5) | n/a |
| `history` | the last verdict on this item (date, verdict, cite) and the user's last correction | 2 |
| `corrections` | 5 recent user corrections of this check (reason class + one line) | 5 |

**Decision schema (one JSON object):**

```json
{"verdict":"done|partial|not_done|not_mine|not_needed|duplicate|waiting_on_them",
 "basis":"delivered|answered|confirmed|done_by_other|resolved|moment_passed|record_fixed|none",
 "cite":"c3", "confidence":0.0, "needs":"≤12 words or null",
 "need_more":null | {"what":"thread|email_thread|drive_file","ref":"<id from the pack>"}}
```

- The parser keeps today's citation rules (`done` cites my line after the ask, and so on).
- `need_more` is honoured once. Code fetches that object live (allowlisted read tools), appends ≤ 10 lines, and re-asks the same tier.

**Escalation to Sonnet:** only when all of these hold:

1. the verdict would change state (done / not_mine / not_needed);
2. confidence is in [0.5, 0.8) or the citation is invalid;
3. the hints disagree with the verdict (e.g. D1/D5 fired but `not_done`, or `askerChasedAfterMine` but `done`).

`still_yours` at good confidence never escalates. This is a cost change for the LLM-COST lane; precision on the answer key must be re-measured (`scripts/settle/score.ts`).

**Policy:** today's `decideSettle`, with R1's rule, also applied by the closure machine.

**Tools, if a tool-using variant is wanted:**

| Tool | Args | Returns |
|---|---|---|
| `rc_thread_since` | `ref`, `since` | lines `{id, at, by, text≤600, files}` (DB first, live read if stale) |
| `rc_my_messages_to` | `person`, `since` | ≤ 8 lines |
| `rc_file_activity` | `fileId \| keywords`, `since` | ≤ 3 revisions with diff line |
| `rc_record_state` | `entity` | the read-back fields |
| `rc_finish` | the schema above | none |

**Compared with today:**

| | Today | Proposed |
|---|---|---|
| Inputs | `check-completion` (about 2.3 K tokens of skill) sees ≤ 6 new lines with no history. `settle-item` (about 3.6 K tokens of skill) sees a rich Slack/Gmail/Calendar pack, but no files, records or sessions | One pack covers both |
| Rules | Neither uses deterministic rules | D1–D6 decide what code can decide |
| Memory | No memory of prior verdicts | Last verdict and corrections in the pack |
| Model calls | Two model calls per event | One |
| `cc-tools` | Scanner write tools only; the resolution passes have no tools | The `rc_*` set above, if wanted |

**Read-ins (`src/llm/readin/*`):** keep them as the Sonnet research desk, triggered by:

- a direct ask under 48 h with no reply of mine (D1/D2 not fired);
- entering the top 5;
- meeting prep within 24 h.

Bounds:

- one per item per generation (already enforced);
- ≤ 8 tool calls and the existing daily cap;
- skip when the resolution check says `done` or `not_mine` at ≥ 0.7.

Its `alreadyAnswered` finding feeds the resolution check (R14), so the expensive read is not wasted.

### 4.2 Observability (answers Q6)

1. **Table `closure_checks`**, one row per decision, privacy-safe:
   - `work_item_id`, `at`, `trigger`, `rules_fired[]`, `pack_hash`;
   - `verdict`, `basis`, `confidence`, `cite_source_item_id`;
   - `model`, `cost_usd`, `escalated`;
   - `action` (close / ask / wait / leave);
   - `blocked_by` (e.g. `user_reopened`, `below_threshold`, `upcoming_meeting`, `open_loop`, `ask_first_person`).

   No message text. Retention: 30 days, like `scan_run_events`.
2. **Item Details ▸ "Why is this still open?"** shows:
   - the last check (when, verdict, cited line link);
   - the gate that blocked it;
   - what would trigger the next check;
   - a **Check now** button (enqueues one item).
3. **`npm run scan:explain -- --item <workItemId>`**: origin → run → triage verdict → the closure_checks history → the evidence timeline. Reuse `src/scanner/trace/queries.ts`.
4. **Recall sweep (nightly, deterministic):** list source items with `addressed_to_me`, no evidence link, no triage verdict, and an ask pattern ("?", "can you", "please"). Report them as a Health count with links. It catches SCN-1, SCN-9 and SCN-10 regressions without a model.
5. `scan:report` adds three counts: Slack threads re-read, messages dropped by the triage cap, and notes with 0 parsed steps.

### 4.3 Eval harness for recall and closure precision (answers Q7)

Existing assets to build on:

- `scripts/stress/missbank.ts`: Slack recall per variant, with live Haiku and private recordings.
- `scripts/stress/completion-replay.ts` and `scripts/settle/score.ts`, scored against the private answer key.
- `src/scanner/completion/types.ts` `CompletionModel`: a seam that is easy to fake.
- `tests/bereeval/*`: a real Postgres reevaluate.
- `src/llm/chat/fake.ts`: a scripted model pattern.

These need Postgres, private data and money. The gap is a **public, CI-able, zero-cost** layer:

1. **Golden cases** in `tests/fixtures/scanner-golden/<case>.json`. Each case holds:
   - `sources[]` (placeholder Slack/Gmail/Calendar/Drive rows, shaped like `sample-data/tables/source_items.json`);
   - `items_expected[]` (title keywords, kind, origin source id);
   - `closures_expected[]` (item → verdict + cite, or "stays open").

   Seed them from the `sample-data/CAST-work.md` storylines:
   - wi-002 / wi-004: reply-after-ask, should close;
   - wi-006: open, reply pending;
   - wi-060: auto-close then reopen by a late reply;
   - wi-008: gone quiet;
   - wi-016: asset delivered, likely done.

   Add SCN-1 (thread reply without mention), SCN-4 (chase after a close), SCN-9 (ask past 1000 chars) and SCN-14 (two deliverables, one DM).
2. **Deterministic layer (no model)**, asserting:
   - candidate selection (`collectCandidates`);
   - D1–D6 rules;
   - DUP-1;
   - policy (`decideSettle`);
   - pack completeness: "the deciding line is in the pack", the `scripts/settle/context-check.ts` idea, made a unit test.

   Runs in the memory store (`store-memory.ts`) in milliseconds.
3. **Cassette model.** A `CompletionModel` that replays recorded JSON verdicts keyed by `ledgerHash(model, skill, system, user)` (already computed in `pass.ts`). A missing key fails the test with the prompt hash. `npm run eval:record` refreshes cassettes with live Haiku, on demand, and is ledgered.
4. **Scores, printed and thresholded in CI:**
   - item recall on golden asks (≥ 0.9);
   - close precision (0 wrong closes on "still owed" cases);
   - close rate on "settled" cases (track it; don't gate);
   - clicks left.
5. **Fidelity caveat:** sample-data is synthetic. Its `closure_kind` values and its Gemini heading format differ from production (SCN-5, SCN-11), so fixtures must be checked against real tool-output shapes (`tests/fixtures/scanner/**`).

## 5. Decisions for Tristan

1. **Correction rule.**
   - Option A, today: any touch means never auto-close.
   - Option B: only "reopened, Kept or Not done" blocks auto-close. Accept, snooze and edits don't.
   - **Recommend B.** It matches *tenet: Suggest, then learn* word for word, and removes most "Looks done" clicks on triaged items.
2. **One closer or two.**
   - Option A: keep the completion pass and Settle.
   - Option B: merge into one resolution check (R4).
   - **Recommend B.** One rule set, one log, half the calls. It needs a shadow-mode release scored on the answer key.
3. **A follow-up after an auto-close.**
   - Option A: reopen automatically (the `reopenOnFollowUp` default true, which today does nothing).
   - Option B: create a new "chased again" sibling.
   - Option C: ask.
   - **Recommend A** for the asker writing to me within 14 days. Show "Reopened: PERSON wrote again", with Undo.
4. **Slack thread re-reads** (R5) cost extra reads every poll.
   - Option A: every inbox poll, ≤ 10 threads.
   - Option B: every 30 min, ≤ 25 threads.
   - **Recommend B** to start; let the LLM-COST lane price it.
5. **Sonnet escalation scope in resolution.**
   - Option A, today: every `still_yours` escalates.
   - Option B: only state-changing verdicts that are uncertain or contradict the hints.
   - **Recommend B**, after re-scoring on the answer key. That key is the only precision evidence we have (*north star: Trustworthy*).

No recommendation here conflicts with a tenet. R1 and R2 *restore* compliance with *Suggest, then learn*. All writes stay inside the app's own DB; nothing new leaves (*Nothing leaves without approval*).

## 6. What's fine, don't touch

- **Ingest mechanics:**
  - Idempotent recording (dedupe key + content hash computed in code, `handlers.ts:175-197`).
  - The coverage ledger with cursor-and-coverage atomic commit.
  - S8c clamps, FS-ORDER oldest-first backfill, and FS-2 hole re-plans. The ramp ended with 0 holes and 0 dead jobs.
- **REC-1/REC-2:** recording from tool results so the model never transcribes. It is the right pattern for cheap models.
- **The Slack triage design** (TRI-1/2/3, TRI-CTX, carried verdicts) and the deterministic `proposalGate`: the right place for hard rules.
- **The Settle pack** (`load-db.ts` people-based retrieval, long-DM middle selection, hints) and the answer-key method (FIRST-SCAN-RAMP §7: 90% bucket accuracy, about 98% close precision). Extend it; don't rewrite it.
- **The closure machine's** reopen-vs-sibling, lock-to-proposal and loop-back logic, and change-set Undo.
- **Record-derived closers** (VDP/DC read-backs, `docs/EDGE-CASES.md` DC-*, VD-*).
- **`scan_run_events` and the trace tooling** for source-side questions.

## 7. Open questions / not verified

- How often Settle passes end `partial` in steady state (check `jobs.result.status` for `settle.check`). This sizes SCN-7.
- Slack search index lag in this workspace (SCN-10). A probe would compare `Message_ts` with first-seen-at.
- Which Gemini notes format current docs use (SCN-11). Check `meeting_notes` rows with a summary but 0 steps.
- Whether an Undo of a completion-pass close also removes its `done_check:` evidence, which affects how fast SCN-2 re-closes. The ramp notes say Settle evidence is removed. I did not trace the completion path.
- How many live `source_item_refs` rows are `url` + `drive:%` (SCN-13).
- Whether accepting from Triage is common enough in practice that SCN-3 explains most of the "doesn't auto-close" complaint. Count settle `ask_looks_done` decisions whose only note is "you changed it before".
