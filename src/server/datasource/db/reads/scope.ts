/**
 * Page-scoped reads (p4-page-scoped-reads, 09 R2): every read model is loaded for one explicit scope, and a scope
 * names the collections its page renders and, where the page shows a window or one record, the rows.
 *
 *   briefing        Home, Today: open work, plus what closed or changed since the window start (the earlier of
 *                   now − days and the user's last-active time, so "closed since you left" survives a long absence),
 *                   plus anything due inside ±days; their evidence and NBAs; the calendar ±days plus every meeting a
 *                   loaded item or initiative points at; drafts, activity and the rest whole (the quarter's log, open
 *                   drafts, the briefs and the footer are on the page)
 *   triage          Triage: the briefing's work window (Closed for you is 14 days) with its evidence
 *   outbox          Outbox: drafts, and only the items and evidence the drafts point at
 *   activity:<view> Activity: log (the week + suggestions), rows (the row list), ledger (activity only), history
 *                   (the month grid's window on items, meetings and time blocks)
 *   vdp, deals      the VDP coverage and the Deals list (deals: live items only, for the open-task counts)
 *   account:<id>    one account: its items, everything else the account page and its needs read
 *   item:<id>       one work item: the item, its initiative's siblings, their evidence, NBAs, meeting and drafts
 *   health          Health: connectors (the ledgers are SQL counts; `ops` loads them for the jobs list)
 *   work            the Work list (GET /items): the items the list query can show (reads/work-list.ts: the tab's
 *                   states, narrowed in SQL by account, opp, initiative and kind, plus text and source as a superset the
 *                   view filters again; the Closed tab one page with `limit`), what they point at (accounts, opps,
 *                   initiatives whole, as the briefing; their meetings by id) and the connectors (stale marks)
 *   briefs          Briefs: the briefs and their watches (post-2.0 read profile, 27-read-profile.md)
 *   agents          Agents (GET /agents) and its tool panel (GET /tools): the agent runs (Claude sessions, app runs, the
 *                   tool-run mirrors), the tool runs and the adapters, nothing else (post-caps-ui, 27-read-profile.md)
 *   chat            the Assistant's thread list: the chat threads
 *   settings        Settings: the base read only (the user, settings, policies, people, kv)
 *   guide           Getting started: connectors and drafts (its chat and DC counts are SQL counts)
 *   needs           the Needs-you queue: ONE model per request shared by its ten providers (db/index.ts). Every
 *                   collection, every row: its providers read 14 weeks of activity and every meeting for the row
 *                   suggestions, and the DC and use-case engines read their own wide inputs
 *   all             every collection, every row: writers (inside their transaction) and the routes not page-scoped
 *                   yet. It carries a reason so a reader can see why, and a test counts them
 *
 * A page that reads a collection its scope did not load gets a ScopeMissError: in tests (strict) it throws, so a
 * miss fails loudly; at runtime the read is retried once with that collection added and logs
 * `BUG.READ_SCOPE_MISS` (the page is right, and slower, until the scope is fixed). A page opened for an id outside
 * its window (an item 60 days closed) is one targeted read by id (`item:<id>`), never a widened window.
 */
import type { ItemsQuery } from '@/contract';

import type { CollectionName } from '../model';

export type ActivityView = 'log' | 'rows' | 'ledger' | 'history';

/** The Work list query a `work` scope loads for (its filters, tab and page). */
export type WorkListScope = Pick<ItemsQuery, 'tab' | 'account' | 'opp' | 'initiative' | 'source' | 'kind' | 'q' | 'cursor' | 'limit'>;

export type ReadScope =
  | { kind: 'briefing'; openWork: true; days: number }
  | { kind: 'triage' }
  | { kind: 'outbox' }
  | { kind: 'activity'; view: ActivityView; /** history: the month grid (YYYY-MM) or the one local day (YYYY-MM-DD) shown */ month?: string; day?: string }
  | { kind: 'vdp' }
  | { kind: 'deals' }
  | { kind: 'account'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'health' }
  | { kind: 'work'; list: WorkListScope }
  | { kind: 'briefs' }
  | { kind: 'agents' }
  | { kind: 'chat' }
  | { kind: 'settings' }
  | { kind: 'guide' }
  | { kind: 'needs' }
  | { kind: 'all'; why: string; /** collections a retry added to a page scope (internal) */ widenedFrom?: ReadScope };

/** Home / Today / Needs' briefing: open work ± 14 days. */
export const BRIEFING = { kind: 'briefing', openWork: true, days: 14 } as const satisfies ReadScope;
export const TRIAGE = { kind: 'triage' } as const satisfies ReadScope;
export const OUTBOX = { kind: 'outbox' } as const satisfies ReadScope;
export const VDP = { kind: 'vdp' } as const satisfies ReadScope;
export const DEALS = { kind: 'deals' } as const satisfies ReadScope;
export const HEALTH = { kind: 'health' } as const satisfies ReadScope;
export const NEEDS = { kind: 'needs' } as const satisfies ReadScope;
export const BRIEFS = { kind: 'briefs' } as const satisfies ReadScope;
export const AGENTS = { kind: 'agents' } as const satisfies ReadScope;
export const CHAT = { kind: 'chat' } as const satisfies ReadScope;
export const SETTINGS = { kind: 'settings' } as const satisfies ReadScope;
export const GUIDE = { kind: 'guide' } as const satisfies ReadScope;
export const activityScope = (view: ActivityView): ReadScope => ({ kind: 'activity', view });
/** History: the month grid shown (`month`, default this month) or one local day (`day`): their window only. */
export const historyScope = (o: { month?: string; day?: string }): ReadScope => ({ kind: 'activity', view: 'history', ...(o.day ? { day: o.day } : { month: o.month ?? '' }) });
export const accountScope = (id: string): ReadScope => ({ kind: 'account', id });
export const itemScope = (id: string): ReadScope => ({ kind: 'item', id });
/** The Work list: the rows this query can show (undefined fields dropped, so equal queries make equal scopes). */
export const workScope = (q: WorkListScope): ReadScope => ({ kind: 'work', list: JSON.parse(JSON.stringify(q)) as WorkListScope });
/** Every collection and row, for a stated reason (writers, routes not page-scoped yet). */
export const everything = (why: string): ReadScope => ({ kind: 'all', why });

/** The spend summary is not a collection; scopes that show it name it here. */
export type ScopeExtra = 'spend';

/** The collections each page scope renders (or composes from). `all` = every collection. */
const COLLECTIONS: { [K in Exclude<ReadScope['kind'], 'all'>]: readonly CollectionName[] } = {
  briefing: ['people', 'accounts', 'opps', 'missedOpps', 'initiatives', 'workItems', 'evidence', 'nbas', 'drafts', 'proposals', 'events', 'slots', 'activity', 'agentRuns', 'briefs', 'connectors', 'mappings'],
  triage: ['people', 'accounts', 'opps', 'missedOpps', 'initiatives', 'workItems', 'evidence', 'events', 'mappings', 'connectors'],
  outbox: ['people', 'drafts', 'workItems', 'evidence', 'connectors'],
  activity: [], // per view, below
  vdp: ['people', 'accounts', 'opps', 'drafts'],
  // activity: the last call on each account (D-103 (d): a dismissed DC gap or finding comes back once on a call)
  deals: ['people', 'accounts', 'opps', 'missedOpps', 'workItems', 'connectors', 'activity'],
  account: ['people', 'accounts', 'opps', 'missedOpps', 'initiatives', 'workItems', 'assets', 'agentRuns', 'briefs', 'events', 'connectors', 'activity'],
  item: ['people', 'accounts', 'opps', 'initiatives', 'workItems', 'evidence', 'nbas', 'proposals', 'assets', 'drafts', 'events', 'connectors', 'agentRuns'],
  health: ['people', 'connectors', 'workItems'],
  work: ['people', 'accounts', 'opps', 'initiatives', 'workItems', 'events', 'connectors'],
  briefs: ['people', 'briefs', 'watches'],
  agents: ['people', 'agentRuns', 'toolRuns', 'toolAdapters'],
  chat: ['people', 'chatThreads'],
  settings: ['people'],
  guide: ['people', 'connectors', 'drafts'],
  needs: [], // every collection (planOf)
};

const ACTIVITY: { [V in ActivityView]: readonly CollectionName[] } = {
  // the week, its lanes and canvases, and the suggestions (the attribution context reads opps, events, people, runs)
  log: ['people', 'activity', 'drafts', 'events', 'timeBlocks', 'accounts', 'opps', 'agentRuns', 'assets', 'workItems'],
  rows: ['people', 'activity', 'drafts', 'events', 'accounts', 'opps', 'agentRuns', 'assets', 'workItems'],
  ledger: ['people', 'activity'],
  history: ['people', 'accounts', 'activity', 'agentRuns', 'drafts', 'events', 'timeBlocks', 'workItems'],
};

const EXTRAS: { [K in ReadScope['kind']]: readonly ScopeExtra[] } = {
  briefing: ['spend'],
  triage: [],
  outbox: [],
  activity: [],
  vdp: [],
  deals: [],
  account: [],
  item: [],
  health: ['spend'],
  work: [],
  briefs: [],
  agents: [],
  chat: [],
  settings: [],
  guide: [],
  needs: ['spend'],
  all: ['spend'],
};

export interface ScopePlan {
  scope: ReadScope;
  /** null = every collection. */
  collections: ReadonlySet<CollectionName> | null;
  extras: ReadonlySet<ScopeExtra>;
}

/** What a scope loads (collections; the row windows are reads/rows.ts). A widened `all` keeps its page's rows. */
export function planOf(scope: ReadScope): ScopePlan {
  if (scope.kind === 'all' || scope.kind === 'needs') return { scope, collections: null, extras: new Set(EXTRAS[scope.kind]) };
  const cols = scope.kind === 'activity' ? ACTIVITY[scope.view] : COLLECTIONS[scope.kind];
  return { scope, collections: new Set(cols), extras: new Set(EXTRAS[scope.kind]) };
}

/** A short label for logs and the profile: `briefing`, `activity:log`, `item` (never the id). */
export function scopeLabel(scope: ReadScope): string {
  if (scope.kind === 'activity') return `activity:${scope.view}`;
  if (scope.kind === 'all') return `all(${scope.why})`;
  return scope.kind;
}

/** A page read a collection (or extra) its scope did not load. */
export class ScopeMissError extends Error {
  constructor(
    readonly scope: ReadScope,
    readonly missing: CollectionName | ScopeExtra,
  ) {
    super(`read model: ${missing} is not in the ${scopeLabel(scope)} scope (add it to src/server/datasource/db/reads/scope.ts)`);
    this.name = 'ScopeMissError';
  }
}

/**
 * Strict = a scope miss throws (tests: vitest sets VITEST, or CC_READ_SCOPE_STRICT=1). Otherwise the DataSource
 * retries the read once with every collection (logged), so a page never breaks over a missed scope.
 */
export function scopeStrict(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.CC_READ_SCOPE_STRICT === '0') return false;
  return env.CC_READ_SCOPE_STRICT === '1' || !!env.VITEST;
}

/** CC_READ_SCOPES=off: the kill switch back to the 1.x reads (every collection, every row, one model per read). */
export function scopesOff(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CC_READ_SCOPES === 'off';
}
