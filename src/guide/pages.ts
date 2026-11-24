/**
 * Page help (the topbar "?" popover) and the first-visit spotlight tour, per page. Plain data: what the page shows,
 * where its data comes from, the main actions and their keys, and up to four tour steps ("coach marks"), each
 * anchored to an element the page already renders (a CSS selector; a step whose element is missing is skipped, not
 * marked seen). A step has a short title and a body of one or two sentences in the app's plain voice.
 *
 * Persona-aware (D-55): a line or mark with `feature` shows only when that feature is active for the user, and
 * `personas` limits it to some roles. A page can add a sentence for one persona with `personaNote`.
 *
 * Getting started lists one explore item per main page with a tour (`EXPLORE`, "Tour Home"), done once the tour is
 * (`pageToured`). The action items' own tips (Show me) live next door, in items.ts.
 */
import type { PersonaFeature, PersonaId } from '@/contract';
import { featureActive, type ResolvedPersona } from '@/personas';
import type { RouteKey } from '@/components/shell/routes';

interface Scoped {
  feature?: PersonaFeature;
  personas?: readonly PersonaId[];
}

export interface HelpAction extends Scoped {
  text: string;
  /** A KbdHint combo ("mod+enter", "j|k"). */
  keys?: string;
}

export interface CoachMarkDef extends Scoped {
  /** Stable id, stored in settings.guide.seen ("home.dayline"). */
  id: string;
  /** CSS selector of an element the page renders (the first one shown is highlighted). */
  selector: string;
  /** The step card's title: a few words naming the thing. */
  title: string;
  /** The step card's body: one or two sentences on what it is and what to do with it. */
  text: string;
  /** Which side of the element the card prefers (it flips or moves when there is no room). */
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export interface PageHelpDef {
  title: string;
  /** What the page shows, in one or two sentences. */
  shows: string;
  /** Where its data comes from. */
  sources: string;
  actions: readonly HelpAction[];
  personaNote?: Partial<Record<PersonaId, string>>;
  marks: readonly CoachMarkDef[];
}

export interface PageHelp {
  key: RouteKey;
  title: string;
  shows: string;
  sources: string;
  note: string | null;
  actions: HelpAction[];
  marks: CoachMarkDef[];
}

const LIST_KEYS: HelpAction[] = [
  { text: 'Move through the list', keys: 'j|k' },
  { text: 'Open the selection in Details', keys: 'enter' },
  { text: 'Do its main action', keys: 'mod+enter' },
  { text: 'Done · Snooze', keys: 'd|s' },
];

export const PAGE_HELP: Partial<Record<RouteKey, PageHelpDef>> = {
  home: {
    title: 'Home',
    shows: 'Your day on one screen: a one-sentence summary, the calendar strip, the top three things to do now, and everything else grouped by what you would do with it.',
    sources: 'Ranked from the work the scanners found in Slack, Gmail, Calendar, Drive, meeting notes and Org62, using your priority policy (Settings ▸ Priority policy).',
    actions: [
      { text: 'Jump to a Do now card', keys: '1|2|3' },
      ...LIST_KEYS,
      { text: 'Plan the next working day: the Today / Tomorrow toggle in the header' },
    ],
    personaNote: {
      se: 'Log & fix collects what Org62 and VDP still need from you: unlogged meetings, missing DCs, VDP gaps.',
      ae: 'Log & fix collects forecast notes due Monday, deal roles still set to None and opps with no Specialist Forecast.',
    },
    marks: [
      { id: 'home.masthead', selector: 'section.hm-mast', title: 'Your day in one sentence', text: 'Written from your calendar and open work, and rewritten as the day changes.', side: 'bottom' },
      { id: 'home.dayline', selector: 'section.hm-day', title: 'Today’s calendar', text: 'Click a meeting for its prep and notes. Open slots show what would fit in them.', side: 'bottom' },
      { id: 'home.donow', selector: 'section.hm-lead-wrap', title: 'Do now', text: 'The three things to do next, ranked by your priority policy. Press 1–3 to jump to one and ⌘↵ to do it.', side: 'top' },
      { id: 'home.pagehelp', selector: '[data-guide="page-help"]', title: 'Help on every page', text: 'This button explains the page you are on: what it shows, where it comes from and its keys. It can replay this tour too.', side: 'bottom' },
    ],
  },
  today: {
    title: 'Today',
    shows: 'The working day as a timeline: meetings, focus blocks and the work planned around them.',
    sources: 'Your calendar plus the ranked work list; planned blocks are yours to move.',
    actions: [{ text: 'Zoom the day in / out / fit', keys: '=|-' }, { text: 'Move a planned block 15 min', keys: 'alt+up|alt+down' }, ...LIST_KEYS],
    marks: [],
  },
  triage: {
    title: 'Triage',
    shows: 'What the scanners think might be yours but need you to confirm: asks and promises, meeting takeaways, mapping questions and items that look done.',
    sources: 'New findings from every source, before they become work items. Nothing here is acted on until you accept it.',
    actions: [{ text: 'Accept', keys: 'a' }, { text: 'Not now (says why, tunes the scanner)', keys: 'n' }, { text: 'Move through the list', keys: 'j|k' }],
    marks: [
      { id: 'triage.list', selector: '[data-testid="triage-list"] [data-item-id]', title: 'Confirm, don’t retype', text: 'Each row is a guess with its evidence. Accept it (a) or say why not (n); either way the scanner learns.', side: 'bottom' },
      { id: 'triage.closed', selector: 'section[data-section="closed_for_you"]', title: 'Closed for you', text: 'What the app closed on its own in the last 14 days, each with the message that settled it and Undo.', side: 'top' },
    ],
  },
  outbox: {
    title: 'Outbox',
    shows: 'Every drafted message waiting for your approval, plus what is scheduled, sent and failed.',
    sources: 'Drafts the app wrote from your threads and email, and the ones you queued from a composer. Logging canvases and VDP changes are applied on Activity instead.',
    actions: [{ text: 'Open a draft to edit it', keys: 'enter' }, { text: 'Approve the selection', keys: 'mod+enter' }, { text: 'Preview as the recipient sees it', keys: 'alt+p' }],
    marks: [
      { id: 'outbox.dryrun', selector: '[data-testid="dry-run-mode"]', title: 'Dry run or live', text: 'With dry run on, approving renders the exact message and keeps it here: nothing leaves this machine. Switch it in Settings ▸ Sending.', side: 'bottom' },
      { id: 'outbox.row', selector: '[data-testid="outbox-row"]', title: 'One row per draft', text: 'Where it goes and the message it answers. Open it to edit, then approve; nothing is sent before you do.', side: 'bottom' },
    ],
  },
  assistant: {
    title: 'Assistant',
    shows: 'A chat that knows your work: ask about a deal, a meeting or your week, or ask it to change something in the app.',
    sources: 'It reads what the app has, and can run read-only lookups in Slack, Org62 and Google. Changes it proposes are staged for you to apply, with Undo.',
    actions: [{ text: 'Open the Assistant from any page', keys: 'mod+j' }, { text: 'Add context (an item, an account)', keys: '@' }, { text: 'Send', keys: 'mod+enter' }],
    marks: [],
  },
  work: {
    title: 'Work',
    shows: 'Every open work item, by tab: what to do now, this week, later, and what looks done.',
    sources: 'Items the scanners created from your sources, the ones you captured, and their evidence. Edited fields stay yours: the engines propose instead of overwriting.',
    actions: [...LIST_KEYS, { text: 'Capture a new to-do', keys: 'c' }],
    marks: [
      { id: 'work.tabs', selector: '[aria-label="Work tabs"]', title: 'Tabs by kind', text: 'All open work, then the same work by kind: what you said you’d do, what was asked of you, promises and trainings. Snoozed and Done are here too.', side: 'bottom' },
      { id: 'work.filter', selector: '[role="search"][aria-label="Filter work"]', title: 'Narrow it down', text: 'Search, or filter by account, initiative, source or kind. Group the list by when it’s due or by initiative.', side: 'bottom' },
    ],
  },
  workItem: {
    title: 'Work item',
    shows: 'One item with its evidence, next best action, draft and history.',
    sources: 'Evidence links back to the Slack message, email, meeting or record it came from.',
    actions: [{ text: 'Do the next best action', keys: 'mod+enter' }, { text: 'Open the source', keys: 'o' }, { text: 'Done · Snooze', keys: 'd|s' }],
    marks: [],
  },
  deals: {
    title: 'Deals',
    shows: 'A summary of your deals and your pipeline by fiscal quarter, then your accounts and opportunities with what each needs from you.',
    sources: 'Org62 opportunities you are on (or own), with the work, meetings and threads linked to each account. The summary and chart count only your deals, from the Org62 mirror.',
    actions: [{ text: 'List the deals behind a number: click a tile, a bar segment or a table cell' }, { text: 'Open an account', keys: 'enter' }, { text: 'Move through the list', keys: 'j|k' }],
    personaNote: {
      se: 'The summary counts opps you are on the team of or hold a DC on, at 100% of the opp amount. VDP coverage and missed opportunities live here too.',
      ae: 'The summary counts the Specialist Forecasts you own, at their forecast amount (ACV). Forecast notes, Deal Role fixes and opps with no Specialist Forecast are on Activity ▸ Forecast.',
    },
    marks: [
      { id: 'deals.summary', selector: '[data-guide="deals-summary"]', title: 'Deals summary', text: 'Your open pipeline, this quarter, wins, what closes soon and what needs a look. Click a number to list its deals.', side: 'bottom' },
      { id: 'deals.pipeline', selector: '[data-guide="deals-pipeline"]', title: 'Pipeline by quarter', text: 'How much pipe sits in each fiscal quarter, stacked by forecast category. Hover a bar for amounts, click it for the deals.', side: 'bottom' },
      { id: 'deals.needs', selector: 'section[aria-label="Needs you"]', title: 'Needs you', text: 'What your deals are missing from you right now, the soonest due first.', side: 'right' },
      { id: 'deals.accounts', selector: 'section[aria-label="Accounts"]', title: 'Accounts', text: 'Open one for its opportunities, people, meetings and open work in one place.', side: 'left' },
    ],
  },
  missed: {
    title: 'Missed opportunities',
    shows: 'Opportunities you probably helped on but are not credited for.',
    sources: 'Your meetings and threads matched against Org62 opportunity teams and deal contributions.',
    actions: [{ text: 'Claim one: the form asks the split and role, and it becomes a DC request on your next logging canvas (Deals ▸ DCs)' }, { text: 'Dismiss with a reason', keys: 'n' }],
    marks: [],
  },
  account: {
    title: 'Account',
    shows: 'One account: its opportunities, people, recent meetings and threads, and open work.',
    sources: 'Org62 for the account and opportunities; your sources for everything linked to it.',
    actions: [{ text: 'Ask the Assistant about this account', keys: 'mod+j' }],
    marks: [],
  },
  briefs: {
    title: 'Briefs',
    shows: 'Digests of the channels and opportunities you watch: what changed, and the highlights worth acting on.',
    sources: 'Slack channels and Org62 opportunities you subscribe to under Manage watches.',
    actions: [{ text: 'Promote a highlight to Triage, or make it a task' }, { text: 'Not relevant (tunes what shows up)' }],
    marks: [
      { id: 'briefs.watches', selector: '[data-testid="manage-watches"]', title: 'Choose what to watch', text: 'Add a channel or an opportunity, and say how often you want its brief.', side: 'bottom' },
      { id: 'briefs.list', selector: 'aside[aria-label="Briefs"]', title: 'Your briefs', text: 'One per watch. Open one for what changed and the highlights worth acting on.', side: 'right' },
    ],
  },
  agents: {
    title: 'Agents',
    shows: 'Claude sessions and app runs: what is running, what is done and waiting for review, and what needs a nudge.',
    sources: 'Your local Claude Code sessions and the research and tool runs the app started.',
    actions: [{ text: 'Start a session in Claude from a prompt' }, { text: 'Answer a waiting run inline (app runs)' }],
    marks: [
      { id: 'agents.start', selector: '[data-testid="start-in-claude"]', title: 'Hand work to Claude', text: 'Starts a Claude Code session with the context filled in. You review what it did here.', side: 'bottom' },
    ],
  },
  tools: {
    title: 'Tools',
    shows: 'The local tools the app can run for you, their health and recent runs.',
    sources: 'Tool manifests registered on this install (tools-registry/*.json). A fresh install may have none: most are local tools from the owner’s own projects.',
    actions: [{ text: 'Run a tool (always an explicit Run)' }],
    marks: [],
  },
  time: {
    title: 'Activity',
    shows: 'What you log to Org62 (hours, DCs, use cases) and push to VDP, where each landed, and the batches you apply.',
    sources: 'Your calendar and onsite days become activity rows; the app suggests the account, opportunity and type for each.',
    actions: [
      { text: 'Fix what needs you, then Log to Slackbot: one canvas you Apply here', feature: 'activityLogging' },
      { text: 'Apply a staged canvas or VDP change (each is its own Apply)' },
      { text: 'Mark a trip: a date range onsite at one account' },
      { text: 'Draft the week’s forecast notes and stage them as one canvas', feature: 'specialistForecast' },
    ],
    personaNote: {
      se: 'Two tabs: Org62 (Log it first, then Needs you, Weeks, Ledger, Use cases) and VDP (Changes to push, and My VDPs at a glance).',
      ae: 'Forecast is where the Monday notes and deal-role fixes are drafted and applied.',
    },
    marks: [
      { id: 'time.areas', selector: '[aria-label="Org62 or VDP"]', title: 'Org62 and VDP', text: 'VDP has two tabs: Changes, where you tick what goes to VDP and Push it, and My VDPs, each VDP at a glance.', side: 'bottom', feature: 'vdp' },
      { id: 'time.views', selector: '[aria-label="Org62 views"]', title: 'Log it first', text: 'Log it is only logging. Needs you is only what needs you; Weeks, Ledger and Use cases show what was found and where it landed.', side: 'bottom' },
      { id: 'time.quarter', selector: '[data-testid="q4-log"]', title: 'The quarter at a glance', text: 'Hours in Org62 against your target, what still waits on you, and where a canvas’s hours landed.', side: 'bottom', feature: 'activityLogging' },
      { id: 'time.forecast', selector: '[data-testid="forecast-queue"]', title: 'This week’s forecast notes', text: 'The notes due Monday, biggest deals first. Draft them, approve each, then stage one canvas for Slackbot.', side: 'bottom', feature: 'specialistForecast' },
    ],
  },
  history: {
    title: 'Journal',
    shows: 'What you did on any past day: work finished, meetings, messages sent, runs and Org62 updates. Hours are counted on Activity ▸ History.',
    sources: 'The app’s own record of changes, the activity log, the calendar and the Outbox.',
    actions: [{ text: 'Pick a day on the month grid' }],
    marks: [],
  },
  health: {
    title: 'Health',
    shows: 'Whether every source is live, what the scanners did, the job queue, LLM spend and errors.',
    sources: 'The worker’s heartbeat, scan runs and connector probes.',
    actions: [{ text: 'Re-auth a source (shows the exact command)' }, { text: 'Rescan a source now' }, { text: 'Retry a failed job' }],
    marks: [
      { id: 'health.needs', selector: 'section[aria-label="Needs you"]', title: 'Fix these first', text: 'A source that needs re-auth stops scanning until you sign in again. Each row gives the exact fix.', side: 'bottom' },
      { id: 'health.sources', selector: 'section[aria-label="Sources"]', title: 'Sources', text: 'How fresh each source is (“through 10:41”) and when it last ran.', side: 'right' },
    ],
  },
  settings: {
    title: 'Settings',
    shows: 'Everything you can tune: your role and rules, priority policy, closing, sending, budgets and sources.',
    sources: 'Saved on this machine. Each section says how it saves: some apply at once, some wait for Save.',
    actions: [{ text: 'Find a setting', keys: 'mod+k' }, { text: 'Move between sections', keys: 'up|down' }],
    marks: [
      { id: 'settings.find', selector: 'input[aria-label="Find a setting"]', title: 'Find a setting', text: 'Type what you want to change; the section list filters as you type.', side: 'bottom' },
      { id: 'settings.effect', selector: '[data-testid="settings-effect"]', title: 'See the effect first', text: 'This pane shows what a change does, from your real data, before you save it.', side: 'left' },
    ],
  },
  initiative: {
    title: 'Initiative',
    shows: 'A group of related work items with their progress.',
    sources: 'Items linked to the initiative by the scanners or by you.',
    actions: LIST_KEYS,
    marks: [],
  },
};

function inScope(x: Scoped, persona: ResolvedPersona | null): boolean {
  if (!persona) return !x.feature && !x.personas;
  if (x.personas && !x.personas.includes(persona.id)) return false;
  if (x.feature && !featureActive(persona, x.feature)) return false;
  return true;
}

/** The page's help for this persona (null persona: while settings load, only lines that need no persona). */
export function pageHelpFor(key: RouteKey, persona: ResolvedPersona | null): PageHelp | null {
  const def = PAGE_HELP[key];
  if (!def) return null;
  return {
    key,
    title: def.title,
    shows: def.shows,
    sources: def.sources,
    note: (persona && def.personaNote?.[persona.id]) ?? null,
    actions: def.actions.filter((a) => inScope(a, persona)),
    marks: def.marks.filter((m) => inScope(m, persona)),
  };
}

/** Every coach mark id (Settings ▸ About counts how many you have seen). */
export const ALL_MARK_IDS: readonly string[] = Object.values(PAGE_HELP).flatMap((p) => p?.marks.map((m) => m.id) ?? []);

// ─── Explore items (Getting started) ───────────────────────────────────────────────────────────────────────────

/**
 * The seen key a finished tour writes ("tour.home"): Done on its last step. A step whose element was missing stays
 * unseen (a later visit shows it), but the page counts as toured. Skip records every step, so it counts too.
 */
export const tourDoneKey = (page: RouteKey): string => `tour.${page}`;

export interface ExploreDef {
  page: RouteKey;
  /** "Tour Home". */
  title: string;
  href: string;
  /** What the page is for, in one line. */
  detail: string;
  personaDetail?: Partial<Record<PersonaId, string>>;
  /** The page belongs to a persona feature: no explore item while it is inactive. */
  feature?: PersonaFeature;
}

/** One explore item per main page with a tour, in the order Getting started lists the ones it doesn't interleave. */
export const EXPLORE: readonly ExploreDef[] = [
  { page: 'home', title: 'Tour Home', href: '/', detail: 'Your day on one screen: what to do now, your calendar and the rest of your work.' },
  { page: 'triage', title: 'Tour Triage', href: '/triage', detail: 'What the scanners think is yours, waiting for you to confirm it.' },
  { page: 'outbox', title: 'Tour the Outbox', href: '/outbox', detail: 'Every drafted message waits here for your approval.' },
  {
    page: 'time',
    title: 'Tour Activity',
    href: '/activity',
    detail: 'Org62: log your hours, DCs and use cases, Log it first; VDP: push changes, see each VDP.',
    personaDetail: { ae: 'Your Monday forecast notes and Deal Role fixes, drafted and applied here.' },
  },
  { page: 'deals', title: 'Tour Deals', href: '/deals', detail: 'Your pipeline by quarter, your accounts and opportunities, and what each needs from you.' },
  { page: 'work', title: 'Tour Work', href: '/work', detail: 'Every open work item: now, this week and later.' },
  { page: 'briefs', title: 'Tour Briefs', href: '/briefs', detail: 'Digests of the channels and opportunities you watch.' },
  { page: 'agents', title: 'Tour Agents', href: '/agents', detail: 'Claude sessions and app runs, and the ones waiting for your review.' },
  { page: 'health', title: 'Tour Health', href: '/health', detail: 'Whether every source is live, and what the scanners did.' },
  { page: 'settings', title: 'Tour Settings', href: '/settings', detail: 'Everything you can tune, with the effect shown before you save.' },
];

/** The explore items this persona gets: a page with at least one tour step for them, whose feature is active. */
export function exploreFor(persona: ResolvedPersona): ExploreDef[] {
  return EXPLORE.filter((e) => (!e.feature || featureActive(persona, e.feature)) && (pageHelpFor(e.page, persona)?.marks.length ?? 0) > 0);
}

/** The page's tour is done: it was finished or skipped, or every one of its steps (for this persona) was seen. */
export function pageToured(page: RouteKey, persona: ResolvedPersona, seen: Readonly<Record<string, string>>): boolean {
  if (seen[tourDoneKey(page)]) return true;
  const marks = pageHelpFor(page, persona)?.marks ?? [];
  return marks.length > 0 && marks.every((m) => Boolean(seen[m.id]));
}
