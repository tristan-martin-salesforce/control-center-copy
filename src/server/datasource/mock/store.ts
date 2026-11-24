/**
 * In-memory store for the mock DataSource: Map-per-collection, a unit-of-work transaction that records
 * row images for undo, and the audit log (inverse payloads, field-level undo, autosave coalescing).
 *
 * Rule: never mutate a stored object in place. Always `tx.put` a new object.
 */
import type { DcSuggestionRow } from '@/engines/attribution/dc';
import type { LearnedRule } from '@/engines/attribution/types';
import type { UcCandidateRow } from '@/engines/use-cases/types';
import { nanoid } from 'nanoid';
import type {
  Account,
  ActivityEntry,
  Actor,
  AgentRun,
  Asset,
  AuditEntry,
  Brief,
  CalendarEvent,
  ChatThreadDetail,
  Connector,
  Draft,
  EntityRef,
  EventLogEntry,
  Evidence,
  FieldChange,
  Initiative,
  Job,
  LiveTopic,
  MappingQuestion,
  MissedOpp,
  NbaCard,
  NeedDecision,
  Opportunity,
  Person,
  PolicyVersion,
  Proposal,
  ScanRun,
  Seed,
  SeedMeta,
  Settings,
  SpendSummary,
  SpineSlot,
  TimeDismissRule,
  TimelineBlock,
  ToolAdapter,
  ToolRun,
  WatchSubscription,
  WorkItemRecord,
} from '@/contract';
import { needKey } from '@/lib/need-decisions';
import type { DcRequestRecord } from '@/server/deals/dc-requests';
import type { IdentityOverride } from '@/engines/vdp/identity';
import { AppError, notFound } from '@/server/errors';

export type MetaState = SeedMeta & { rankedAt: string; policyRankVersion: number };
export type TimeBlockRec = TimelineBlock & { lane: 'focus' | 'claude' | 'drive' | 'slack' };

/** One canvas row's edits (src/lib/canvas/overrides.ts RowOverride, keyed). */
export interface RowOverrideRec {
  key: string;
  fields: Record<string, string | string[]>;
  at: string;
}

export interface Collections {
  meta: MetaState;
  settings: Settings;
  spend: SpendSummary;
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
  /** D-58: Deal Contribution requests (not in seeds: created in the app). */
  dcRequests: DcRequestRecord;
  /** Needs you: Snooze / Not needed decisions per {rule, subjectId} (src/contract/needs.ts; not in seeds). */
  needDecisions: NeedDecision;
  /** D-64: "Dismiss all from <source>" rules per source key (not in seeds). */
  timeDismissRules: Omit<TimeDismissRule, 'rows'>;
  /** D-69: your VDP company mappings (Change…), per node key (placeholders built at reset, src/mock/vdp.ts). */
  vdpIdentity: IdentityOverride;
  /** 2026-11-13 audit B2: your edits on canvas rows before Apply (src/lib/canvas/overrides.ts; the db's kv), per row key (not in seeds). */
  rowOverrides: RowOverrideRec;
  /** The attribution engine's learned rules (the db's mapping_rules; not in seeds: learned from your corrections). */
  learnedRules: LearnedRule;
  /** The DC suggestions and their decisions (the db's dc_suggestions; not in seeds: the batch makes them). */
  dcSuggestions: DcSuggestionRec;
  /** Use cases to add (the db's use_case_candidates; not in seeds: the extraction makes them, mock/use-cases.ts). */
  useCaseCandidates: UcCandidateRow;
}

/** A stored DC suggestion (src/engines/attribution/dc.ts) with when it was decided. */
export type DcSuggestionRec = DcSuggestionRow & { decidedAt: string | null };
export type CollectionName = keyof Collections;

/** Which query topics a write to each collection invalidates. */
export const COLLECTION_TOPICS: Record<CollectionName, LiveTopic[]> = {
  meta: ['today', 'time'],
  settings: ['settings', 'today', 'policy', 'outbox', 'health'],
  spend: ['health', 'today'],
  people: ['search'],
  accounts: ['deals'],
  opps: ['deals'],
  missedOpps: ['deals', 'triage', 'today'],
  initiatives: ['initiative', 'item', 'today'],
  workItems: ['today', 'items', 'item', 'triage', 'initiative', 'deals', 'since'],
  evidence: ['item'],
  nbas: ['nba', 'today', 'item'],
  // 'time': a pending logging-canvas item holds its rows (ActivityEntry.canvasDraftId is derived from drafts)
  // 'deals': a DC request's and a use case's stage is derived from the canvas drafts (the db's map)
  drafts: ['draft', 'nba', 'outbox', 'today', 'item', 'time', 'deals'],
  proposals: ['item', 'nba', 'today', 'draft'],
  assets: ['item', 'initiative'],
  events: ['calendar', 'today'],
  slots: ['calendar', 'today'],
  agentRuns: ['agents', 'today', 'item'],
  toolAdapters: ['tools'],
  toolRuns: ['tools', 'tool_run', 'agents'],
  activity: ['time'],
  timeBlocks: ['time'],
  briefs: ['briefs', 'today'],
  watches: ['watches', 'briefs'],
  connectors: ['health', 'today', 'item', 'items'],
  scanRuns: ['scans', 'health'],
  jobs: ['jobs', 'health'],
  eventLog: ['event_log', 'health'],
  chatThreads: ['chat'],
  mappings: ['triage', 'today'],
  policyVersions: ['policy'],
  // the db's map (src/server/events/topics.ts): Deals ▸ DCs, Time ▸ Log it, the sidebar badge and Home ▸ Log & fix
  dcRequests: ['deals', 'time', 'today', 'home'],
  needDecisions: ['deals', 'home', 'today'],
  timeDismissRules: ['time', 'settings'],
  vdpIdentity: ['deals', 'today'],
  rowOverrides: ['draft', 'time', 'deals'],
  learnedRules: ['settings', 'time'],
  dcSuggestions: ['time', 'deals', 'home'],
  useCaseCandidates: ['time', 'deals'],
};

const keyOf: { [K in CollectionName]: (v: Collections[K]) => string } = {
  meta: () => 'current',
  settings: () => 'current',
  spend: () => 'current',
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
  dcRequests: (v) => v.id,
  needDecisions: (v) => needKey(v.rule, v.subjectId),
  timeDismissRules: (v) => v.key,
  vdpIdentity: (v) => v.key,
  rowOverrides: (v) => v.key,
  learnedRules: (v) => v.id,
  dcSuggestions: (v) => v.id,
  useCaseCandidates: (v) => v.id,
};

type Maps = { [K in CollectionName]: Map<string, Collections[K]> };

function toMap<K extends CollectionName>(name: K, rows: Collections[K][]): Map<string, Collections[K]> {
  const m = new Map<string, Collections[K]>();
  for (const r of rows) m.set(keyOf[name](r), r);
  return m;
}

export class Store {
  readonly c: Maps;

  constructor(seed: Seed) {
    this.c = {
      meta: new Map([['current', { ...seed.meta, rankedAt: seed.meta.asOf, policyRankVersion: seed.settings.policy.version }]]),
      settings: new Map([['current', seed.settings]]),
      spend: new Map([['current', seed.spend]]),
      people: toMap('people', seed.people),
      accounts: toMap('accounts', seed.accounts),
      opps: toMap('opps', seed.opps),
      missedOpps: toMap('missedOpps', seed.missedOpps),
      initiatives: toMap('initiatives', seed.initiatives),
      workItems: toMap('workItems', seed.workItems),
      evidence: toMap('evidence', seed.evidence),
      nbas: toMap('nbas', seed.nbas),
      drafts: toMap('drafts', seed.drafts),
      proposals: toMap('proposals', seed.proposals),
      assets: toMap('assets', seed.assets),
      events: toMap('events', seed.calendar.events),
      slots: toMap('slots', seed.calendar.slots),
      agentRuns: toMap('agentRuns', seed.agentRuns),
      toolAdapters: toMap('toolAdapters', seed.toolAdapters),
      toolRuns: toMap('toolRuns', seed.toolRuns),
      activity: toMap('activity', seed.activity),
      timeBlocks: toMap('timeBlocks', seed.timeBlocks),
      briefs: toMap('briefs', seed.briefs),
      watches: toMap('watches', seed.watches),
      connectors: toMap('connectors', seed.connectors),
      scanRuns: toMap('scanRuns', seed.scanRuns),
      jobs: toMap('jobs', seed.jobs),
      eventLog: toMap('eventLog', seed.eventLog),
      chatThreads: toMap('chatThreads', seed.chatThreads),
      mappings: toMap('mappings', seed.mappings),
      policyVersions: toMap('policyVersions', seed.policyVersions),
      dcRequests: new Map(),
      needDecisions: new Map(),
      timeDismissRules: new Map(),
      vdpIdentity: new Map(),
      rowOverrides: new Map(),
      learnedRules: new Map(),
      dcSuggestions: new Map(),
      useCaseCandidates: new Map(),
    };
  }

  get<K extends CollectionName>(col: K, id: string): Collections[K] | undefined {
    return this.c[col].get(id);
  }

  must<K extends CollectionName>(col: K, id: string, what: string): Collections[K] {
    const v = this.c[col].get(id);
    if (!v) throw notFound(what, id);
    return v;
  }

  all<K extends CollectionName>(col: K): Collections[K][] {
    return [...this.c[col].values()];
  }

  meta(): MetaState {
    return this.c.meta.get('current')!;
  }
  settings(): Settings {
    return this.c.settings.get('current')!;
  }
  spend(): SpendSummary {
    return this.c.spend.get('current')!;
  }

  /** Raw write (used by Tx and undo). */
  _set<K extends CollectionName>(col: K, value: Collections[K]): void {
    this.c[col].set(keyOf[col](value), value);
  }
  _delete<K extends CollectionName>(col: K, id: string): void {
    this.c[col].delete(id);
  }
  keyFor<K extends CollectionName>(col: K, value: Collections[K]): string {
    return keyOf[col](value);
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface RowOp {
  col: CollectionName;
  id: string;
  before: unknown | null;
  after: unknown | null;
  /** Top-level fields that changed (field-level undo). */
  fields: string[];
}

export class Tx {
  private touched = new Map<string, { col: CollectionName; id: string; before: unknown | null }>();

  constructor(readonly store: Store) {}

  private touch(col: CollectionName, id: string) {
    const k = `${col}:${id}`;
    if (!this.touched.has(k)) this.touched.set(k, { col, id, before: this.store.get(col, id) ?? null });
  }

  put<K extends CollectionName>(col: K, value: Collections[K]): Collections[K] {
    const id = this.store.keyFor(col, value);
    this.touch(col, id);
    this.store._set(col, value);
    return value;
  }

  /** Read-modify-write helper. */
  update<K extends CollectionName>(col: K, id: string, fn: (old: Collections[K]) => Collections[K]): Collections[K] {
    const old = this.store.get(col, id);
    if (!old) throw notFound(col, id);
    return this.put(col, fn(old));
  }

  remove<K extends CollectionName>(col: K, id: string): void {
    this.touch(col, id);
    this.store._delete(col, id);
  }

  ops(): RowOp[] {
    const out: RowOp[] = [];
    for (const t of this.touched.values()) {
      const after = this.store.get(t.col, t.id) ?? null;
      const fields = changedFields(t.before, after);
      if (t.before === null && after === null) continue;
      if (t.before !== null && after !== null && fields.length === 0) continue;
      out.push({ col: t.col, id: t.id, before: t.before, after, fields });
    }
    return out;
  }
}

const VOLATILE = new Set(['version', 'updatedAt', 'savedAt', 'rendered', 'doc']);

export function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  const out: string[] = [];
  for (const k of keys) {
    const a = (before as Record<string, unknown>)[k];
    const b = (after as Record<string, unknown>)[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k);
  }
  return out;
}

export function fieldChanges(op: RowOp): FieldChange[] {
  if (!op.before || !op.after) return [];
  return op.fields
    .filter((f) => !VOLATILE.has(f))
    .map((f) => ({ field: f, before: (op.before as Record<string, unknown>)[f] ?? null, after: (op.after as Record<string, unknown>)[f] ?? null }));
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface RecordInput {
  at: string;
  actor: Actor;
  action: string;
  summary: string;
  entity: EntityRef;
  related?: EntityRef[];
  ops: RowOp[];
  undoable?: boolean;
  undoOf?: string | null;
  coalesceKey?: string;
}

const COALESCE_MS = 30_000;

export class MockAuditLog {
  readonly entries: AuditEntry[] = [];
  private inverses = new Map<string, RowOp[]>();
  private coalesce = new Map<string, { auditId: string; atMs: number }>();

  get(id: string): AuditEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  inverseOf(id: string): RowOp[] | undefined {
    return this.inverses.get(id);
  }

  /** Seed history (display-only unless ops are supplied). */
  importEntry(entry: AuditEntry, ops?: RowOp[]): void {
    this.entries.push(entry);
    if (ops) this.inverses.set(entry.id, ops);
  }

  record(input: RecordInput): AuditEntry {
    const changes = input.ops.flatMap((op) => fieldChanges(op));
    const atMs = Date.parse(input.at);

    if (input.coalesceKey) {
      const prev = this.coalesce.get(input.coalesceKey);
      const prevEntry = prev ? this.get(prev.auditId) : undefined;
      const isLatest = prevEntry && this.entries[this.entries.length - 1]?.id === prevEntry.id;
      if (prev && prevEntry && !prevEntry.undoneAt && isLatest && atMs - prev.atMs < COALESCE_MS) {
        const merged = mergeOps(this.inverses.get(prevEntry.id) ?? [], input.ops);
        this.inverses.set(prevEntry.id, merged);
        const mergedEntry: AuditEntry = {
          ...prevEntry,
          at: input.at,
          summary: input.summary,
          changes: merged.flatMap((op) => fieldChanges(op)),
        };
        this.entries[this.entries.length - 1] = mergedEntry;
        this.coalesce.set(input.coalesceKey, { auditId: prevEntry.id, atMs });
        return mergedEntry;
      }
    }

    const entry: AuditEntry = {
      id: `aud_${nanoid(10)}`,
      at: input.at,
      actor: input.actor,
      action: input.action,
      summary: input.summary,
      entity: input.entity,
      related: input.related ?? [],
      changes,
      undoable: input.undoable ?? true,
      undoneAt: null,
      undoOf: input.undoOf ?? null,
    };
    this.entries.push(entry);
    this.inverses.set(entry.id, input.ops);
    if (input.coalesceKey) this.coalesce.set(input.coalesceKey, { auditId: entry.id, atMs });
    return entry;
  }

  markUndone(id: string, at: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i >= 0) this.entries[i] = { ...this.entries[i], undoneAt: at };
    for (const [k, v] of this.coalesce) if (v.auditId === id) this.coalesce.delete(k);
  }

  forEntity(type: string, id: string): AuditEntry[] {
    return this.entries.filter((e) => (e.entity.type === type && e.entity.id === id) || e.related.some((r) => r.type === type && r.id === id));
  }
}

function mergeOps(first: RowOp[], next: RowOp[]): RowOp[] {
  const out = first.map((o) => ({ ...o }));
  for (const n of next) {
    const existing = out.find((o) => o.col === n.col && o.id === n.id);
    if (existing) {
      existing.after = n.after;
      existing.fields = changedFields(existing.before, existing.after);
    } else out.push(n);
  }
  return out;
}

/** Field-level inverse: restore `before[fields]` if the row still matches `after[fields]`. */
export function planUndo(store: Store, ops: RowOp[], at: string): Array<{ col: CollectionName; id: string; next: unknown | null }> {
  const plan: Array<{ col: CollectionName; id: string; next: unknown | null }> = [];
  for (const op of [...ops].reverse()) {
    const current = store.get(op.col, op.id) as Record<string, unknown> | undefined;
    if (op.before === null) {
      // insert → delete
      plan.push({ col: op.col, id: op.id, next: null });
      continue;
    }
    if (op.after === null || !current) {
      // delete → re-insert
      plan.push({ col: op.col, id: op.id, next: op.before });
      continue;
    }
    const after = op.after as Record<string, unknown>;
    const before = op.before as Record<string, unknown>;
    const fields = op.fields.filter((f) => f !== 'version' && f !== 'updatedAt');
    const drifted = fields.filter((f) => JSON.stringify(current[f]) !== JSON.stringify(after[f]));
    if (drifted.length) {
      throw new AppError('conflict', `Changed since: ${drifted.join(', ')} on ${op.col} ${op.id}; review before undoing`, {
        current,
        drifted,
      });
    }
    const next: Record<string, unknown> = { ...current };
    for (const f of op.fields) {
      if (f === 'version' || f === 'updatedAt') continue;
      if (f in before) next[f] = before[f];
      else delete next[f];
    }
    if (typeof current.version === 'number') next.version = current.version + 1;
    if ('updatedAt' in current) next.updatedAt = at;
    plan.push({ col: op.col, id: op.id, next });
  }
  return plan;
}
