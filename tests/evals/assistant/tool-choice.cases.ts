/**
 * Tool-choice goldens: a user ask → the first of the eleven tools the Assistant should reach for, read from the
 * served descriptions (picker.ts). `why` says what in the descriptions should decide it. To add a case, add one object
 * below (README.md).
 */
export type ToolName = 'query' | 'read' | 'search' | 'fetch' | 'explain' | 'propose' | 'act' | 'plan' | 'run' | 'remember' | 'help';

export interface ToolChoiceCase {
  ask: string;
  expect: ToolName;
  why: string;
}

export const TOOL_CHOICE_CASES: ToolChoiceCase[] = [
  // ---- query: the app's data as a table, before anything live ----
  { ask: 'which opps close this quarter with no hours logged?', expect: 'query', why: 'a filter over the opps view (close date, hours)' },
  { ask: 'how many hours did I log last week?', expect: 'query', why: 'a count over the time_entries view' },
  { ask: 'list my snoozed items', expect: 'query', why: 'the work_items view, tab snoozed' },
  { ask: 'which accounts have no DC yet?', expect: 'query', why: 'the accounts view has dcStatus' },
  { ask: 'what meetings with Fabrikam are on my calendar next month?', expect: 'query', why: 'the meetings view is the calendar the app has: answer from it before searching live' },
  { ask: 'what do my deals need from me?', expect: 'query', why: 'the needs view' },
  { ask: 'which people at Initech does the app know?', expect: 'query', why: 'the people view' },
  { ask: 'how much have my spend holds used today?', expect: 'query', why: 'the spend_holds view' },

  // ---- read: one page or record of the app as the UI has it ----
  { ask: "what's on the health page?", expect: 'read', why: 'a page of the app' },
  { ask: 'what would the next logging batch contain?', expect: 'read', why: 'read log_batch previews it; propose stages it' },
  { ask: 'open the briefs page', expect: 'read', why: 'a page of the app' },
  { ask: 'show me the item history page for this item', expect: 'read', why: 'item_history is a read page' },

  // ---- search: find by words, the ledger first, then live sources ----
  { ask: "find Dana's email about pricing", expect: 'search', why: 'words in Gmail: search, not fetch (no thread id yet)' },
  { ask: 'search Slack for the Globex security review', expect: 'search', why: 'live Slack search by words' },
  { ask: 'find the Initech deck in Drive', expect: 'search', why: 'Drive search by words' },
  { ask: 'did the scanners record anything about SSO?', expect: 'search', why: 'the scan ledger by words' },
  { ask: 'find the Globex opportunity in Org62 by name', expect: 'search', why: 'Org62 by name words (the fixed SELECT)' },

  // ---- fetch: one thing whole, by its id or link ----
  { ask: 'read the whole Gmail thread 18c2f0a1b2c3d4e5', expect: 'fetch', why: 'a thread id: read it whole' },
  { ask: 'read this Slack thread https://example.slack.com/archives/C0123ABCD/p1731000000123456', expect: 'fetch', why: 'a Slack permalink: one thread' },
  { ask: 'open Drive file id 1AbCdEfGhIjK and read it all', expect: 'fetch', why: 'a Drive file id' },
  { ask: 'pull Org62 opportunity 006000000000001AAA', expect: 'fetch', why: 'an 18-character opportunity id' },

  // ---- explain: any "why" about an item or a time row ----
  { ask: 'why is the Globex renewal ranked first?', expect: 'explain', why: 'why an item ranks' },
  { ask: 'why is this item still open?', expect: 'explain', why: 'closure: why it stays open' },
  { ask: 'why was this time row attributed to the Acme opp?', expect: 'explain', why: 'attribution of a time row' },

  // ---- propose: stage it for the user's Apply ----
  { ask: 'draft a reply to Dana saying Thursday works', expect: 'propose', why: 'a draft for the Outbox' },
  { ask: 'stage a card that claims DCs on these three opps', expect: 'propose', why: 'a card of changes' },
  { ask: 'update the Globex VDP next step field to POC kickoff', expect: 'propose', why: 'a VDP change waits for Apply' },
  { ask: 'prepare a Claude Code session in the demo repo', expect: 'propose', why: 'a session link' },
  { ask: 'stage the logging canvas for this week', expect: 'propose', why: 'log_batch staging' },

  // ---- act: the app's own safe actions, asked for in this message ----
  { ask: 'snooze the Globex VDP update until 2pm', expect: 'act', why: 'snooze is an act' },
  { ask: 'pin the Initech follow-up', expect: 'act', why: 'pin is an act' },
  { ask: 'that one is not mine', expect: 'act', why: 'not_mine is an act' },
  { ask: 'mark the ACME demo prep done', expect: 'act', why: 'done on a named item is an act (propose is for cards)' },

  // ---- plan: before a research-class run ----
  { ask: 'research everything we did with Fabrikam live across Slack, Gmail and Drive', expect: 'plan', why: 'run research needs a plan first' },
  { ask: 'find assets for the Globex VDP', expect: 'plan', why: 'vdp_find_assets needs a plan first' },

  // ---- run: a sub-run that reads ----
  { ask: 'rescan the Slack connector over the last 48 hours', expect: 'run', why: 'a rescan' },
  { ask: 'start the sign-in window for the VDP connector', expect: 'run', why: 'reauth starts the user’s own sign-in' },
  { ask: 'sync my forecast job', expect: 'run', why: 'a job (syncForecast)' },

  // ---- remember / help ----
  { ask: 'remember that I log in 15-minute steps, for every thread', expect: 'remember', why: 'a standing preference' },
  { ask: 'keep a note for this conversation: Dana is out until Monday', expect: 'remember', why: 'a thread note' },
  { ask: 'what can you do?', expect: 'help', why: 'what you can do, with examples' },
  { ask: 'which playbook should you read before DC work?', expect: 'help', why: 'the playbooks are in help' },

  // ---- post-2.0: remember only on the user's ask, reauth only on a sign-in ask, the batch past ten ----
  { ask: 'from now on, keep in mind that I never draft in French', expect: 'remember', why: 'the user asks to keep a standing preference' },
  { ask: 'find the email where Dana asks me to remember the renewal date', expect: 'search', why: 'a mail that says "remember" is something to find, not a preference to keep' },
  { ask: 'sign me in to okta again', expect: 'run', why: 'a sign-in ask: run reauth (vdp signs in through Okta)' },
  { ask: 'my gmail sign-in expired, sign me in to gmail again', expect: 'run', why: 'a sign-in ask naming the connector' },
  { ask: 'search Slack for the login outage Sam reported', expect: 'search', why: 'words about a sign-in are a search, not a sign-in' },
  { ask: 'show me the applied logging canvases past the first ten', expect: 'read', why: 'read log_batch pages applied canvases by appliedOffset' },
];
