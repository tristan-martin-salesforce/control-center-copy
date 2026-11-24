/**
 * The read model: the contract collections one page composes from, mapped from Postgres rows (store/*.ts).
 *
 * p4-page-scoped-reads (09 R2): every load names a scope (reads/scope.ts). Home and Today load the briefing (open
 * work ± 14 days, their meetings, evidence and cards); every other page loads only the collections it renders, and
 * where it shows a window or one record, only those rows (reads/rows.ts). Writers load `everything(…)` inside their
 * transaction. Reading a collection the scope left out throws a ScopeMissError (the DataSource retries once with
 * every collection outside tests). Selection and ordering that DATA-MODEL §6 specifies (Q1 ranked lanes, Q6
 * closed-for-you, Q9 triage, Q13 history, Q16 briefs, …) run as SQL in views.ts / audit.ts against the same snapshot.
 */
import { eq } from 'drizzle-orm';

import type {
  Account,
  ActivityEntry,
  AgentRun,
  Asset,
  Brief,
  CalendarEvent,
  ChatThreadDetail,
  Connector,
  Draft,
  EventLogEntry,
  Evidence,
  Initiative,
  Job,
  MappingQuestion,
  MissedOpp,
  NbaCard,
  Opportunity,
  Person,
  PolicyVersion,
  Proposal,
  ScanRun,
  Settings,
  SpendSummary,
  SpineSlot,
  ToolAdapter,
  ToolRun,
  WatchSubscription,
  WorkItemRecord,
} from '@/contract';
import { ClosingSettings, FeedbackSettings, prioritySettingsOf, GuideSettings, PersonaSettings, DEFAULT_CHAT_SETTINGS, DEFAULT_CLOSING_SETTINGS, DEFAULT_SCANNING_SETTINGS, vdpRefreshCommand, DEFAULT_TIME_SETTINGS, DisplaySettings, ScanningSettings, TimeSettings } from '@/contract';
import type { Db } from '@/db/client';
import { users } from '@/db/schema';

import { dayWindow, monthGrid, monthOf, todayIn } from '@/server/history/compose';

import { loadKvAndSections } from './ext';
import { planOf, ScopeMissError, type ReadScope, type ScopeExtra } from './reads/scope';
import { accountItemIds, briefingItemIds, briefingWindow, draftItemIds, eventIdsFor, historyActivityIds, historyItemIds, itemFamilyIds, liveItemIds, timeBlockIdsIn, type Window } from './reads/rows';
import { workListIds } from './reads/work-list';
import { readInStates, withReadInStates } from './readin';
import { loadAppRuns, loadSessions, loadToolAdapters, loadToolRuns } from './store/agents';
import { loadBriefs, loadWatches } from './store/briefs';
import type { ReadCtx } from './store/common';
import { loadAccounts, loadAssets, loadCalendarEvents, loadOpportunities, loadPeople, loadPersonRefs } from './store/entities';
import { loadConnectors, loadEventLog, loadJobs, loadScanRuns, loadSpend } from './store/health';
import { loadChat, loadMappings, loadMissed, loadSlots } from './store/misc';
import { loadDrafts, loadNbas } from './store/nba';
import { loadPolicies, readMeta, type MetaState, type PolicyEngineState } from './store/settings';
import { emptyVocab, loadActivity, loadTimeBlocks, loadVocab, type TimeBlockRec, type Vocab } from './store/time';
import { loadEvidence, loadInitiatives, loadProposals, loadWorkItems } from './store/work';
import { sendingOf } from '@/outbox/settings';

export interface Collections {
  people: Person;
  accounts: Account;
  opps: Opportunity;
  missedOpps: MissedOpp;
  initiatives: Initiative;
  workItems: WorkItemRecord;
  evidence: Evidence;
  nbas: NbaCard;
  drafts: Draft;
  proposals: Proposal;
  assets: Asset;
  events: CalendarEvent;
  slots: SpineSlot;
  agentRuns: AgentRun;
  toolAdapters: ToolAdapter;
  toolRuns: ToolRun;
  activity: ActivityEntry;
  timeBlocks: TimeBlockRec;
  briefs: Brief;
  watches: WatchSubscription;
  connectors: Connector;
  scanRuns: ScanRun;
  jobs: Job;
  eventLog: EventLogEntry;
  chatThreads: ChatThreadDetail;
  mappings: MappingQuestion;
  policyVersions: PolicyVersion;
}
export type CollectionName = keyof Collections;

const KEY: { [K in CollectionName]: (v: Collections[K]) => string } = {
  people: (v) => v.id,
  accounts: (v) => v.id,
  opps: (v) => v.id,
  missedOpps: (v) => v.id,
  initiatives: (v) => v.id,
  workItems: (v) => v.id,
  evidence: (v) => v.id,
  nbas: (v) => v.id,
  drafts: (v) => v.id,
  proposals: (v) => v.id,
  assets: (v) => v.id,
  events: (v) => v.id,
  slots: (v) => v.id,
  agentRuns: (v) => v.id,
  toolAdapters: (v) => v.id,
  toolRuns: (v) => v.id,
  activity: (v) => v.id,
  timeBlocks: (v) => v.id,
  briefs: (v) => v.id,
  watches: (v) => v.id,
  connectors: (v) => v.id,
  scanRuns: (v) => v.id,
  jobs: (v) => v.id,
  eventLog: (v) => v.id,
  chatThreads: (v) => v.thread.id,
  mappings: (v) => v.id,
  policyVersions: (v) => String(v.version),
};

export class ReadModel {
  private readonly maps: { [K in CollectionName]: Map<string, Collections[K]> };

  constructor(
    readonly ctx: ReadCtx,
    data: { [K in CollectionName]: Collections[K][] },
    private readonly _meta: MetaState,
    private readonly _settings: Settings,
    private readonly _spend: SpendSummary,
    readonly extra: {
      vocab: Vocab;
      /** Tool adapter key → tool_adapters row id. */
      adapterRowId: Map<string, string>;
      /** Current priority policy row id. */
      policyRowId: string | null;
      /** Engine-only knobs of the current policy row (obligation weight, Top 3 size). */
      policyEngine: PolicyEngineState;
      /** Watches the user doesn't see (auto-managed subscriptions behind opportunity briefs). */
      autoWatchIds: Set<string>;
      /** opportunities rows that only anchor a finding. */
      findingOpps: Map<string, { name: string; accountId: string | null }>;
      connectorByKind: Map<string, string>;
    },
    /** Collections this model did not load (`loadModel({ ops: false })`): reading one throws. */
    unloaded: readonly CollectionName[] = [],
    /** The scope this model was loaded for (reads/scope.ts). */
    readonly scope: ReadScope = { kind: 'all', why: 'constructed' },
    /** Collections or extras the scope left out (a ScopeMissError on read). */
    outOfScope: readonly (CollectionName | ScopeExtra)[] = [],
    /** Collections whose rows are a window or one record's family, not every row (reads/rows.ts). */
    readonly windowed: ReadonlySet<CollectionName> = new Set(),
  ) {
    this.unloaded = new Set(unloaded);
    this.outOfScope = new Set(outOfScope);
    const maps = {} as { [K in CollectionName]: Map<string, Collections[K]> };
    for (const k of Object.keys(KEY) as CollectionName[]) {
      const m = new Map<string, unknown>();
      for (const v of data[k] as unknown[]) m.set((KEY[k] as (x: unknown) => string)(v), v);
      (maps as Record<string, Map<string, unknown>>)[k] = m;
    }
    this.maps = maps;
  }

  private readonly unloaded: ReadonlySet<CollectionName>;
  private readonly outOfScope: ReadonlySet<CollectionName | ScopeExtra>;
  private col<K extends CollectionName>(col: K): Map<string, Collections[K]> {
    if (this.outOfScope.has(col)) throw new ScopeMissError(this.scope, col);
    if (this.unloaded.has(col)) throw new Error(`read model: ${col} was not loaded (load the model with { ops: true })`);
    return this.maps[col];
  }
  /** Whether this model holds `col` (in scope and loaded). */
  has(col: CollectionName): boolean {
    return !this.outOfScope.has(col) && !this.unloaded.has(col);
  }

  get<K extends CollectionName>(col: K, id: string): Collections[K] | undefined {
    return this.col(col).get(id);
  }
  all<K extends CollectionName>(col: K): Collections[K][] {
    return [...this.col(col).values()];
  }
  meta(): MetaState {
    return this._meta;
  }
  settings(): Settings {
    return this._settings;
  }
  spend(): SpendSummary {
    if (this.outOfScope.has('spend')) throw new ScopeMissError(this.scope, 'spend');
    return this._spend;
  }
  /** Replace one record in memory (writers re-read after commit; this keeps a mutation's own view current). */
  put<K extends CollectionName>(col: K, v: Collections[K]) {
    this.col(col).set(KEY[col](v), v);
  }
  remove<K extends CollectionName>(col: K, id: string) {
    this.col(col).delete(id);
  }
}

export class NotSeededError extends Error {
  constructor(what: string) {
    super(`CC_DATA=db: ${what}. Set the database up first: npm run db:bootstrap (or npm run setup)`);
    this.name = 'NotSeededError';
  }
}

export interface LoadModelOptions {
  /** What the caller renders (reads/scope.ts). Required: nothing loads the whole world by default. */
  scope: ReadScope;
  /**
   * PERF-1: run the independent loaders concurrently on the pool. Only for a pool handle: a transaction is one client,
   * and pg deprecates concurrent queries on one client (they would queue anyway).
   */
  parallel?: boolean;
  /**
   * PERF-1: load the operational ledgers (`jobs`, `scanRuns`). They grow with every scan (thousands of rows within a
   * day of a first scan) and only Health's ledger, the jobs list, job retry and a manual scan read them, so pages skip
   * them. Reading an unloaded collection throws (a missed caller fails loudly instead of seeing an empty list).
   */
  ops?: boolean;
}

/** The collections `ops: false` leaves out. */
export const OPS_COLLECTIONS = ['scanRuns', 'jobs'] as const satisfies readonly CollectionName[];

/** A stored `settings.scanning` (any shape) as the contract section; a bad row never breaks the model: defaults. */
function scanningOf(v: unknown): ScanningSettings {
  const p = v ? ScanningSettings.safeParse(v) : undefined;
  return p?.success ? p.data : { ...DEFAULT_SCANNING_SETTINGS };
}

/**
 * The read model for `opts.scope`. Every src/ caller names its scope (tests/reads/scope-lint.test.ts); the default
 * (every collection) is for older test helpers only.
 */
export async function loadModel(db: Db, userId: string, now: Date, opts: LoadModelOptions = { scope: { kind: 'all', why: 'unscoped caller' } }): Promise<ReadModel> {
  loads++;
  const ops = opts.ops ?? true;
  const plan = planOf(opts.scope);
  // Concurrent on the pool, in order on a transaction (same results either way: the loaders share no state).
  const all = opts.parallel ? <T extends readonly unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }) => Promise.all(fns.map((f) => f())) as unknown as Promise<T> : async <T extends readonly unknown[]>(fns: { [K in keyof T]: () => Promise<T[K]> }) => {
    const out: unknown[] = [];
    for (const f of fns) out.push(await f());
    return out as unknown as T;
  };
  const { kv, sections: storedSections } = await loadKvAndSections(db, userId);
  const meta = readMeta({ kv });
  if (!meta) throw new NotSeededError('no meta for this user');
  // What the scope loads: its collections, plus what their loaders derive from (activity and missed opps name their
  // opp and account; proposals label their item or initiative; runs include the tool-run mirrors; briefs their watches)
  const needs = new Set<CollectionName>((Object.keys(KEY) as CollectionName[]).filter((c) => plan.collections === null || plan.collections.has(c)));
  if (needs.has('activity') || needs.has('missedOpps')) needs.add('opps').add('accounts');
  if (needs.has('proposals')) needs.add('workItems').add('initiatives');
  if (needs.has('agentRuns')) needs.add('toolRuns').add('toolAdapters');
  if (needs.has('briefs')) needs.add('watches');
  const want = (c: CollectionName) => needs.has(c);
  const wantSpend = plan.extras.has('spend');
  // the row windows need only the meta (History also the timezone): on the pool they run beside the base reads
  const early = opts.parallel && !(opts.scope.kind === 'activity' && opts.scope.view === 'history') ? scopeRows(db, userId, now, opts.scope, { lastActiveAt: meta.lastActiveAt, timezone: 'UTC' }, want) : null;
  early?.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
  const base = { db, userId, kv };
  // the users row is read once (the people directory and the vocabulary take it from here), `people` once
  let userRead: Promise<typeof users.$inferSelect | undefined> | null = null;
  const user = () => (userRead ??= db.select().from(users).where(eq(users.id, userId)).then((r) => r[0]));
  const sections = storedSections as Partial<Omit<Settings, 'policy'>>;
  const [u, { people, managerId, rows: peopleRows }, pol] = await all([user, () => loadPeople(base, user), () => loadPolicies(base)] as const);
  if (!u) throw new NotSeededError(`user ${userId} does not exist`);
  const personRefs = await loadPersonRefs(base, managerId, peopleRows);
  if (!pol.current || !sections.profile || !sections.sending || !sections.budgets || !sections.display || !sections.agentBehavior) throw new NotSeededError('settings are incomplete');
  const settings: Settings = { profile: sections.profile, policy: pol.current, agentBehavior: sections.agentBehavior, sending: sendingOf(sections.sending), budgets: sections.budgets, display: DisplaySettings.parse(sections.display), chat: sections.chat ?? { ...DEFAULT_CHAT_SETTINGS }, time: timeSettingsOf(sections.time), scanning: scanningOf(sections.scanning), closing: sections.closing ? ClosingSettings.parse(sections.closing) : { ...DEFAULT_CLOSING_SETTINGS }, persona: PersonaSettings.parse(sections.persona ?? { version: 1 }), feedback: FeedbackSettings.parse(sections.feedback ?? { version: 1 }), guide: GuideSettings.parse(sections.guide ?? { version: 1 }), priority: prioritySettingsOf((sections as { priority?: unknown }).priority) };
  const rc: ReadCtx = {
    db,
    userId,
    me: { id: u.personId ?? userId, name: u.displayName ?? meta.user.name },
    timezone: settings.profile.timezone,
    kv,
    people: personRefs,
    now,
  };

  const rows = await (early ?? scopeRows(db, userId, now, opts.scope, { lastActiveAt: meta.lastActiveAt, timezone: settings.profile.timezone }, want));
  const windowed = new Set<CollectionName>();
  if (rows.items) windowed.add('workItems').add('evidence').add('nbas');
  if (rows.events) windowed.add('events');
  if (rows.blocks) windowed.add('timeBlocks');
  if (rows.activity) windowed.add('activity');

  const none = async () => [] as never[];
  const on = <T,>(c: boolean, f: () => Promise<T>, empty: T): (() => Promise<T>) => (c ? f : async () => empty);
  const [accounts, { opps, findingOnly }, vocab, adapters, sessions, appRuns, watchRows, connectors, rawItems, readIns, initiatives, drafts, evidence, nbas, assets, events, timeBlocks, scanRunRows, jobRows, eventLog, chatThreads, spend] = await all([
    on(want('accounts'), () => loadAccounts(rc), []),
    on(want('opps'), () => loadOpportunities(rc), { opps: [], findingOnly: new Map() } as Awaited<ReturnType<typeof loadOpportunities>>),
    // the task and meeting types: activity rows read them, and writers (WHOLE) use them; other pages skip the read
    plan.collections === null || want('activity') ? () => loadVocab(db, userId, { teamPackId: u.teamPackId }) : async () => emptyVocab(u.teamPackId),
    on(want('toolAdapters'), () => loadToolAdapters(rc), []),
    on(want('agentRuns'), () => loadSessions(rc), []),
    on(want('agentRuns'), () => loadAppRuns(rc), []),
    on(want('watches'), () => loadWatches(rc), []),
    on(want('connectors'), () => loadConnectors(rc, { vdpCommand: vdpRefreshCommand(settings.scanning) }), []),
    on(want('workItems'), () => loadWorkItems(rc, rows.items ?? undefined), []),
    on(want('workItems'), () => readInStates(db, userId), new Map() as Awaited<ReturnType<typeof readInStates>>), // BE-READIN
    on(want('initiatives'), () => loadInitiatives(rc), []),
    on(want('drafts'), () => loadDrafts(rc), []),
    on(want('evidence'), () => loadEvidence(rc, rows.items ?? undefined), []),
    on(want('nbas'), () => loadNbas(rc, rows.items ?? undefined), []),
    on(want('assets'), () => loadAssets(rc), []),
    on(want('events'), () => loadCalendarEvents(rc, rows.events ?? undefined), []),
    on(want('timeBlocks'), () => loadTimeBlocks(rc, rows.blocks ?? undefined), []),
    ops && want('scanRuns') ? () => loadScanRuns(rc) : none,
    ops && want('jobs') ? () => loadJobs(rc) : none,
    on(want('eventLog'), () => loadEventLog(rc), []),
    on(want('chatThreads'), () => loadChat(rc), []),
    on(wantSpend, () => loadSpend(rc, settings.budgets, !!(meta as MetaState & { seedHash?: string }).seedHash), EMPTY_SPEND),
  ] as const);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const oppById = new Map(opps.map((o) => [o.id, o]));
  const oppInfo = (id: string) => {
    const o = oppById.get(id);
    if (o) return { name: o.name, stage: o.stage, amount: o.amount, closeDate: o.closeDate, accountName: accountName.get(o.accountId) ?? null };
    const f = findingOnly.get(id);
    return f ? { name: f.name, stage: f.stage, amount: f.amount, closeDate: f.closeDate, accountName: f.accountId ? (accountName.get(f.accountId) ?? null) : null } : null;
  };
  const adapterKey = new Map(adapters.map((a) => [a.rowId, a.manifest.id]));
  const watchInfo = new Map(watchRows.map((w) => [w.id, { targetKind: w.targetKind, label: w.label, accountId: null, oppId: null }]));
  const workItems = withReadInStates(rawItems, readIns);
  const itemTitle = new Map(workItems.map((w) => [w.id, w.title]));
  const initiativeTitle = new Map(initiatives.map((i) => [i.id, i.title]));
  const labelOf = (type: string, id: string) => {
    if (type === 'work_item') return itemTitle.get(id) ?? id;
    if (type === 'draft') return 'Draft body';
    if (type === 'initiative') return initiativeTitle.get(id) ?? id;
    return id;
  };
  const [{ runs: toolRuns, mirrors }, missedOpps, proposals, activity, briefs] = await all([
    on(want('toolRuns'), () => loadToolRuns(rc, adapterKey), { runs: [], mirrors: [] } as Awaited<ReturnType<typeof loadToolRuns>>),
    on(want('missedOpps'), () => loadMissed(rc, oppInfo), []),
    on(want('proposals'), () => loadProposals(rc, labelOf), []),
    on(want('activity'), () => loadActivity(rc, vocab, oppInfo, rows.activity ?? undefined), []),
    on(want('briefs'), () => loadBriefs(rc, watchInfo), []),
  ] as const);

  const data: { [K in CollectionName]: Collections[K][] } = {
    people,
    accounts,
    opps,
    missedOpps,
    initiatives,
    workItems,
    evidence,
    nbas,
    drafts,
    proposals,
    assets,
    events,
    slots: loadSlots(rc),
    agentRuns: [...sessions, ...appRuns, ...mirrors],
    toolAdapters: adapters.map(({ rowId: _r, ...a }) => a),
    toolRuns,
    activity,
    timeBlocks,
    briefs,
    watches: watchRows.filter((w) => !w.autoManaged).map(({ autoManaged: _a, ...w }) => w),
    connectors,
    scanRuns: scanRunRows,
    jobs: jobRows,
    eventLog,
    chatThreads,
    mappings: loadMappings(rc),
    policyVersions: pol.versions,
  };
  // people, slots, mappings and policy versions come with the base read (kv, settings): always in scope
  const outOfScope: (CollectionName | ScopeExtra)[] = (Object.keys(KEY) as CollectionName[]).filter((c) => !needs.has(c) && !ALWAYS.has(c));
  if (!wantSpend) outOfScope.push('spend');
  return new ReadModel(
    rc,
    data,
    meta,
    settings,
    spend,
    {
      vocab,
      adapterRowId: new Map(adapters.map((a) => [a.manifest.id, a.rowId])),
      policyRowId: pol.currentRowId,
      policyEngine: pol.engine,
      autoWatchIds: new Set(watchRows.filter((w) => w.autoManaged).map((w) => w.id)),
      findingOpps: new Map([...findingOnly].map(([id, r]) => [id, { name: r.name, accountId: r.accountId }])),
      connectorByKind: new Map(connectors.map((c) => [c.source, c.id])),
    },
    ops ? [] : OPS_COLLECTIONS,
    opts.scope,
    outOfScope,
    windowed,
  );
}

/** History's window: the month grid (6 weeks around the month) or one local day, as db/history.ts composes them. */
function historyWindow(now: Date, timezone: string, s: { month?: string; day?: string }): Window {
  if (s.day) {
    const d = dayWindow(s.day, timezone);
    return { from: new Date(d.from), to: new Date(d.to) };
  }
  const g = monthGrid(s.month || monthOf(todayIn(now, timezone)));
  return { from: new Date(dayWindow(g.gridStart, timezone).from), to: new Date(dayWindow(g.gridEnd, timezone).to) };
}

let loads = 0;
/** How many read models this process has loaded (the page-read tests count one GET /needs). */
export const modelLoads = () => loads;

/** Collections every scope carries (they come with the base read: the people directory, kv, settings). */
const ALWAYS = new Set<CollectionName>(['people', 'slots', 'mappings', 'policyVersions']);

/** The spend summary of a scope that does not show spend (never read: `spend()` throws a ScopeMissError). */
const EMPTY_SPEND = {} as SpendSummary;

interface ScopeRows {
  /** Work-item ids (their evidence and NBAs follow); null = every item. */
  items: string[] | null;
  events: string[] | null;
  blocks: string[] | null;
  activity: string[] | null;
}

/** The row windows of a scope (reads/rows.ts): null = every row of that collection. */
async function scopeRows(db: Db, userId: string, now: Date, scope: ReadScope, o: { lastActiveAt: string | null | undefined; timezone: string }, want: (c: CollectionName) => boolean): Promise<ScopeRows> {
  const out: ScopeRows = { items: null, events: null, blocks: null, activity: null };
  const eventsFor = (w: Window | null, itemIds: string[] | null) => (want('events') ? eventIdsFor(db, userId, w, itemIds) : Promise.resolve(null));
  switch (scope.kind) {
    case 'briefing':
    case 'triage': {
      const w = briefingWindow(now, scope.kind === 'briefing' ? scope.days : 14, o.lastActiveAt);
      out.items = await briefingItemIds(db, userId, w);
      out.events = await eventsFor(w, out.items);
      return out;
    }
    case 'outbox':
      out.items = await draftItemIds(db, userId);
      return out;
    case 'deals':
      out.items = await liveItemIds(db, userId);
      return out;
    case 'account':
      out.items = await accountItemIds(db, userId, scope.id);
      return out;
    case 'item':
      out.items = await itemFamilyIds(db, userId, scope.id);
      out.events = await eventsFor(null, out.items);
      return out;
    case 'work': // the Work list (reads/work-list.ts); a failed window reads every item and meeting
      out.items = await workListIds(db, userId, scope.list);
      out.events = out.items ? await eventsFor(null, out.items) : null;
      return out;
    case 'activity': {
      if (scope.view !== 'history') return out;
      const w = historyWindow(now, o.timezone, scope);
      out.items = await historyItemIds(db, userId, w);
      out.events = await eventsFor(w, null);
      out.blocks = await timeBlockIdsIn(db, userId, w);
      out.activity = await historyActivityIds(db, userId, w);
      return out;
    }
    default:
      return out;
  }
}

/** Settings ▸ Time (onsite lane): the saved section over the defaults (older users have none). */
function timeSettingsOf(v: unknown): Settings['time'] {
  const r = TimeSettings.safeParse(v);
  return r.success ? r.data : { ...DEFAULT_TIME_SETTINGS, onsiteHours: { ...DEFAULT_TIME_SETTINGS.onsiteHours } };
}
