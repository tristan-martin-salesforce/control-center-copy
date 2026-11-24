# Control Center: UI pivot requirements (2026-11-05)

Source: Tristan's message in the orchestrator session on 2026-11-05. Every builder and researcher reads this file. The numbering is his, so cite items as **R-UI-n** and **R-BE-n**.

The UI is the biggest productivity lever, so it has to be very good. He likes the VDP app UI (`~/Projects/vdp-app`, "VDP Studio" theme).

## Product requirements (R-UI)

1. **Auto-completion across sources.** The app notices when a task gets done and closes it without being asked:
   - Slack says "I'll send an email" and then the email is sent: the task closes.
   - "I'll build a demo org" followed by a finished Claude session that built it: the task closes.
   - If that Claude session is *waiting on me*, the app knows and says so.

   It tracks the status of everything throughout the day, fairly quickly, and detects things I may have missed. Slack and email are scanned constantly.
2. **Trainings.** Trainings I'm behind on show up as lower-level work that is still high priority and recommended for today.
3. **Missed meetings.** If I miss a meeting and a takeaway shows up in the transcript (Gemini notes) or as a Slack follow-up, it becomes a task for me.
4. **Calendar- and effort-aware prioritization.** Ranking considers what's coming up on my calendar and how long each piece of work takes. For example: kick off the long build for the big meeting first, then do the small prep for the easy meeting.
5. **Next best actions (NBA).** Every item gets an NBA that is ready to go. If I need to email or reply to a client, the draft is already written.
   - The NBA updates when new information changes it.
   - A WYSIWYG editor can **send** to different channels (email, Slack) with the correct markup for each, so I'm never guessing.
6. **Activity logging done for me** from all of these signals. It may live in a Slack canvas, but I edit it in this app so I never open the canvas.
7. **Resumable.** If the app is closed (for example the laptop is shut all weekend), it picks up exactly where it left off on Monday. It's a background app.
8. **Background promises.** Older, lower-priority things I said I'd do still surface as background items. Example: "package up the Beacon app for Ravi" was promised over a month ago and could be kicked off in the background.
9. **Manual capture with auto-enrichment.** Items from meetings that never got logged can be added by hand. Example from yesterday's onsite: "talk to product about Nimbus Context Engine gaps and the team's open questions."
   - Once I log it, the app finds the related work: the Claude session and the asset I already made.
   - The NBA then comes back already mostly filled in.
10. **First-class chat** (`claude -p` / Agent SDK) built into the page. I can ask about my day, re-prioritize, and ask it to look up information I know exists but the app missed. It can **change the backend** (tasks, links, priorities, rescans) on request.
11. **A real command center.**
    - Important things are visible at a glance, with smart drill-down.
    - Secondary material moves to other pages.
    - It must not become unmanageable. Research it thoroughly so it's mostly right the first time; expect iterations.
12. **Connector health.** When a connection breaks (for example Gmail needs re-auth), it pops up in the app, ideally with re-auth from inside the app. Re-auth is a wishlist item; showing the problem is required.
13. **Extensibility via tools.** An NBA can launch another tool and come back with a link. Examples:
    - the talk-track app (`~/Projects/talk-track`, :4320) generating a talk track for an upcoming event, slides or demo;
    - Pulse footprint (a local Next.js app, :4318);
    - the D360/AF estimator (afd360-estimator skill).

    Design a plugin seam now.
14. **Org62 missed-opportunity scan.** Find opps I may be missing (generalizing the `docs/dc-sweep` work: D360 opps on my accounts with no DC or activity) so nothing gets lost.

15. **Google Drive as a first-class work signal** (added 2026-11-05).
    - When an action item is slides, a doc or a whitepaper, the app knows the file and its state: last edited, by whom, and what changed since the item was created.
    - It judges whether the requested updates were made.
    - It correlates the file with Slack. **Either can drive status, and both are logged as evidence:**
      - I edit the deck and say nothing in Slack: the item moves to in progress or likely done, from the Drive edits.
      - I say in Slack that it's done: the item closes, with the deck linked.
    - Drive files and assets link to items, accounts and opps automatically.
    - There's no revision-history API through MCP. Forward-sample each file's `modifiedTime`, last modifying user, and a content snapshot or digest, then diff between samples. See D-19 and B-009.

16. **Per-user priorities and agent behavior** (added 2026-11-05). Different people will run their own copy, and each has different ideas of what matters and how the agent should work. For example, Tristan's manager has different priorities than Tristan. Design for this now:
    - **Role starting points.** SE IC, SE manager, and so on.
    - **Editable priority policy.** Weights and rules such as "customer-facing beats internal", "my manager's asks within 24h", "never rank trainings above customer prep". Edit it in Settings *and* by telling the chat. Changes are versioned and explained.
    - **Agent behavior preferences.** Voice, autonomy level per action type, what counts as a task, which sources and channels to watch, and drafting style.

    Every ranking explains itself in terms of *that user's* policy.
17. **Salesforce look and feel** (added 2026-11-05). Use Salesforce branding and typography, like the existing Salesforce-branded Headless demos, so it feels like a Salesforce app rather than a generic one. The Salesforce Lightning Design System (SLDS 2) is public and also documented internally.
    - Keep VDP's *structure and density* lessons.
    - Apply the Salesforce brand: type, color, iconography.

18. **Easy to navigate, save buttons only where needed, undo everywhere** (added 2026-11-05, clarified the same day).
    - Navigation must be obvious and consistent.
    - **Saving is a per-surface design decision.** Don't strip every save button. Use the defaults below, and list each surface in UI-SPEC's save-model table.
      - **Autosave** (about 1 s debounce, plus on blur and on navigation, with a quiet "Saved · 2s ago" status) is the default for low-stakes, private, reversible edits: drafts, notes, task fields, activity-log rows, simple preferences.
      - **Explicit Save or Apply** is for forms where a half-filled state is invalid, changes that trigger expensive or visible recomputation (for example a priority-policy change that re-ranks everything, which gets a preview and then Apply), connector or credential config, and bulk edits.
      - **Explicit Send or Approve, with a confirm,** is for anything leaving the machine.
    - **Undo:** every change can be undone, whether it came from the user, an engine or chat.
      - A toast offers Undo right after the change.
      - ⌘Z works.
      - A per-item history allows rollback.
    - Confirms happen only at the border, meaning anything leaving the machine.

19. **A deliberate feedback model, and good error handling** (added 2026-11-05).
    - **Feedback model.** For every kind of thing the app needs to tell me, choose the channel on purpose and write it down in UI-SPEC's feedback matrix. The channels:
      - toast (transient, usually with Undo);
      - inline status on the item or field;
      - a banner scoped to a page or panel;
      - a badge or count;
      - a status-rail lane;
      - a "Since you left" digest;
      - a macOS notification.

      Rules: at most one channel per event, never a toast storm, and something that needs action must persist (never only a toast).
    - **Error handling** is built in from the start.
      - **UI:**
        - inline field errors;
        - retry affordances;
        - stale or degraded marking on items affected by a broken connector;
        - React error boundaries per panel, so one panel failing never blanks the cockpit;
        - empty, loading and error states for every panel;
        - no silent failures.
      - **Backend:**
        - typed errors;
        - retries with backoff;
        - a dead-letter state for jobs;
        - idempotent re-runs;
        - an error/event log visible on the Health page;
        - LLM output validated against a schema before any DB write.

20. **Async, optimistic, and safe under concurrency** (added 2026-11-05).
    - **Optimistic UI.** Every user change shows up immediately. The server confirms in the background. If it fails, the change rolls back and an inline error appears on that item, with Retry (see R-UI-19). The UI never blocks on a spinner for a local edit.
    - **User and agent concurrency.** Background agents and the user edit the same items, and this must be handled gracefully:
      - optimistic concurrency with per-row versions;
      - **user-touched fields are never silently overwritten by an engine.** The engine proposes the change instead, shown as "New info → update? (diff)";
      - live updates push to open views without stealing focus or moving rows under the cursor.
    - **New info → save first, then re-evaluate async.**
      - Incoming information is saved right away and attached to its item, event or task, marked **new/unread** on that item.
      - That enqueues an async re-evaluation job covering status, NBA, priority and draft.
      - **If new info arrives while a re-evaluation is running, cancel that job and restart with the latest state.** Use a generation counter or abort, and coalesce bursts.
    - **Reopen vs new task.** Say I mark a task done and new information then brings new requirements. Depending on the case, either:
      - the existing item reopens ("Reopened: new requirement from X"), or
      - a new task opens under the same parent.

      The reason and Undo are shown either way. The rule needs documenting: for example, same deliverable and recent means reopen, otherwise a new sibling task.
    - **Every task says what it's for.** Tasks roll up into a bigger **initiative/workstream**, for example "ACME Headless Phase 2 demo". Clicking into a task shows:
      - its purpose line;
      - the sibling tasks of the initiative;
      - the initiative's background context and summary;
      - links to assets (slides, docs, demo orgs, Claude sessions), the people involved, and the opportunity.

21. **Watch subscriptions and briefs** (added 2026-11-05). Each user picks what to follow even when it isn't directly theirs, for example `#team-updates`. Settings are per user (R-UI-16).
    - **Channel or source briefs** cover everything that happened over a period (since the last brief, or daily). Each includes an evaluation of **"worth a closer look for you"** highlights, ranked by relevance to *this user's* accounts, opps, initiatives, skills and policy, with the reasons.
    - **Opportunity briefs** cover every open opportunity I'm on: what changed across the Slack channels, Org62 (stage, close, amount, next steps, team), email, meetings and notes, even when nothing needs me.
    - Any highlight can become a Triage item or task in one click, or be dismissed ("not relevant"), which tunes future relevance.
    - Briefs are reading material, not actions. They never compete with the Top 3, but they're easy to reach every day.

22. **Resolution reasons and involvement** (added 2026-11-05). Every closed item records **how** it was resolved, and the models use that for follow-ups. The reasons:
    - done by me;
    - **handed off to a teammate** (who);
    - done by someone else;
    - no longer needed;
    - duplicate of another item;
    - declined;
    - superseded by a newer item.

    Each item also records my **involvement**: owner, contributor, watcher, or not involved. A hand-off sets the teammate as owner and me as watcher or not involved. After that, new information on that thread or initiative is only context: it doesn't create tasks for me and may show up in briefs. **The exception is a direct ask of me.** Then I'm **looped back in**: the item reopens, or a new item opens, labeled "Looped back in: <person> asked you directly", with evidence and Undo.

23. **Read-ins: background research before I look** (added 2026-11-05). "If I'm pinged a message and there's background for me to respond to the message, it would be cool if Claude did the extra leg work to give me that background. Or anything else for that matter. Basically reading me in to things by doing research so by the time I look at it it's good to go."
    - **Automatic triggers:** direct asks of me, items entering the top of the ranking, and meetings in the next 24 h that are missing prep. Any other item gets a "Read me in" button.
    - **Output:** a TL;DR, background with source links (Slack, Gmail, Drive, Org62, the internal ledger), what I've said or promised before, open questions, and a suggested reply as an Outbox draft in my voice. It never sends.
    - **Refreshing:** it refreshes when new evidence arrives, and the stale generation is cancelled (R-UI-20).
    - **Limits:** read tools only, and no web search. It runs on Sonnet with its own daily budget (default $2/day).
    - **UI:** a violet "✦ Read-in ready" marker on Home and list rows, and the read-in at the top of the Details panel.

## Backend requirements (R-BE)

1. **Relational DB, local for now.** Follow the VDP app: Postgres + Drizzle. Postgres 17 already runs locally via Homebrew on :5432. Get the schema right for everything above.
2. **Cheap scanners.** The scanner agent is mostly **Haiku**, driven by very prescriptive skills that say exactly how to traverse each app, find new information, and log it against the right DB record. Don't burn thousands of dollars on scanning. The smarter work (NBA, drafts) uses a higher tier: Sonnet, or Haiku where that's enough.
3. **Cursors + scan ledger.** Each scanner knows when it last ran and **what** it scanned, so it can resume and later reconcile misses or unlinked items.
4. **The app runs it.** Scanning is part of the running app, not a scheduled Claude task. The app is up nearly all the time; when it restarts, it resumes.

## Process requirements

- Use git worktrees. Split into parallel parts and merge back. The orchestrator orchestrates and does not hand-build.
- **The mocked frontend and the backend start together.** When the frontend looks and feels right, wire it up for real, and push any frontend-driven changes back into the backend.
- Research with subagents. Keep checkpoint logs (`docs/archive/2026-build/CHECKPOINTS.md`) so context compaction doesn't lose state.
- Full-screen desktop only, but it must look good from 1280 px to 2560 px wide. No mobile.
- Ask questions up front, then build without check-ins.
