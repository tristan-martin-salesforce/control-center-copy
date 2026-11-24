// InMemoryScannerStore state, seeding, inspection and shared helpers. Split from store-memory.ts (max-lines); the class is still exported from store-memory.ts.
import {
  type ConnectorHealthProbe, type ConnectorId, type Confidence, type Cursor, type EvidenceRole, type OpenItemDigest,
  type ScopeKey, scopeId,
} from './types';
import type { BriefHighlightsInput, Involvement, OpenItemDigestExt, Resolution } from './runtime/contract-ext';
import {
  type StoreClock, type StoreProfile, type SourceItemRow, type WorkItemRow, type EvidenceRow, type InitiativeRow,
  type RunRow, type LedgerRow, type UnlinkedRow, type InMemoryStoreOptions, DAY, type WorkState, normPerson, tokenize,
  RunStateError, NotFoundError, toMs, personKeys, normDriveRef, type Range, mergeRanges,
} from './store-memory.rows';

/** InMemoryScannerStore's state, test seeding and inspection, and the internal helpers its ScannerStore methods share. InMemoryScannerStore (store-memory.ts) adds the ScannerStore methods. */
export abstract class InMemoryScannerStoreState {
  protected readonly clock: StoreClock;
  protected readonly tol: number;
  protected readonly reopenWindowMs: number;
  protected readonly dayKey: (d: Date) => string;
  protected readonly timeZone: string;
  protected readonly closing: { reopenOnFollowUp: boolean; oldAskDays: number };
  softCapUsd: number;
  hardCapUsd: number;
  profile: StoreProfile;

  protected seq = 0;
  protected readonly sourceItems = new Map<string, SourceItemRow>(); // by id
  protected readonly byDedupe = new Map<string, string>(); // dedupeKey → id
  protected readonly workItems = new Map<string, WorkItemRow>();
  protected readonly byOriginKey = new Map<string, string>();
  protected readonly evidence = new Map<string, EvidenceRow>(); // by `${w}|${s}|${role}`
  protected readonly initiatives = new Map<string, InitiativeRow>();
  protected readonly runs = new Map<string, RunRow>();
  protected readonly cursors = new Map<string, Cursor>();
  protected readonly ledgerRows: LedgerRow[] = [];
  protected readonly unlinked = new Map<string, UnlinkedRow>();
  /** TRI-NOISE: the latest triage verdict per source item (cleared when its content changes). */
  protected readonly verdicts = new Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>();
  protected readonly pendingReeval = new Map<string, Set<string>>();
  protected readonly healthLog = new Map<ConnectorId, ConnectorHealthProbe[]>();
  protected readonly spend: Array<{ day: string; connector: string; model: string; costUsd: number; runId?: string; budget: 'daily' | 'first_scan' }> = [];
  protected readonly briefs = new Map<string, BriefHighlightsInput & { briefId: string; runId: string }>();

  constructor(opts: InMemoryStoreOptions = {}) {
    this.clock = opts.clock ?? { now: () => new Date() };
    this.tol = opts.toleranceMs ?? 1000;
    this.reopenWindowMs = opts.reopenWindowMs ?? 14 * DAY;
    this.timeZone = opts.timeZone ?? 'UTC';
    this.closing = { reopenOnFollowUp: opts.closing?.reopenOnFollowUp ?? true, oldAskDays: opts.closing?.oldAskDays ?? 30 };
    this.dayKey = opts.dayKey ?? ((d) => d.toISOString().slice(0, 10));
    this.softCapUsd = opts.softCapUsd ?? 12;
    this.hardCapUsd = opts.hardCapUsd ?? 15;
    this.profile = opts.profile ?? { me: { userId: 'user_1', name: 'ME' } };
  }

  protected id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  protected nowIso(): string {
    return this.clock.now().toISOString();
  }

  // ------------------------------------------------------------------ seeding / inspection (tests, dev)

  seedProfile(p: StoreProfile): void {
    this.profile = p;
  }

  /** Insert an existing work item (as BE-1 data would hold). Returns its id. */
  seedWorkItem(w: {
    id?: string;
    kind: string;
    title: string;
    purpose?: string;
    state?: WorkState;
    people?: string[];
    accounts?: string[];
    keywords?: string[];
    threadRefs?: string[];
    fileRefs?: string[];
    initiativeId?: string;
    lastEvidenceAt?: string;
    doneAt?: string;
    doneBy?: 'engine' | 'user';
    correction?: 'reopened' | 'kept';
    resolution?: Resolution;
    involvement?: Involvement;
    handedOffTo?: string;
  }): string {
    const id = w.id ?? this.id('wi');
    const row: WorkItemRow = {
      id,
      kind: w.kind,
      title: w.title,
      purpose: w.purpose,
      state: w.state ?? 'open',
      landedAs: 'open',
      newBadge: false,
      confidence: 'sure',
      people: new Set((w.people ?? []).map(normPerson)),
      accounts: new Set(w.accounts ?? []),
      keywords: new Set([...(w.keywords ?? []).map((k) => k.toLowerCase()), ...tokenize(w.title)]),
      threadRefs: new Set(w.threadRefs ?? []),
      fileRefs: new Set(w.fileRefs ?? []),
      initiativeId: w.initiativeId,
      lastEvidenceAt: w.lastEvidenceAt,
      doneAt: w.doneAt,
      ...(w.doneBy ? { doneBy: w.doneBy } : {}),
      ...(w.correction ? { correction: w.correction } : {}),
      resolution: w.resolution,
      involvement: w.involvement,
      handedOffTo: w.handedOffTo,
      originKey: `seed|${id}`,
    };
    this.workItems.set(id, row);
    this.byOriginKey.set(row.originKey, id);
    return id;
  }

  seedInitiative(i: { id?: string; title: string; purpose?: string; accounts?: string[]; keywords?: string[] }): string {
    const id = i.id ?? this.id('ini');
    this.initiatives.set(id, {
      id,
      key: `seed|${id}`,
      title: i.title,
      purpose: i.purpose ?? '',
      workItemIds: [],
      accounts: i.accounts ?? [],
      keywords: (i.keywords ?? []).map((k) => k.toLowerCase()),
    });
    return id;
  }

  /** Simulates BE-3 / the user changing state (e.g. marking done, handing off). */
  setWorkItemState(id: string, state: WorkState, extra: { resolution?: Resolution; involvement?: Involvement; handedOffTo?: string; doneBy?: 'engine' | 'user'; doneAt?: string; correction?: 'reopened' | 'kept' } = {}): void {
    const w = this.mustWork(id);
    w.state = state;
    if (state === 'done') w.doneAt = this.nowIso();
    Object.assign(w, extra);
  }

  getSourceItem(id: string): SourceItemRow | undefined {
    return this.sourceItems.get(id);
  }
  getSourceItemByDedupe(key: string): SourceItemRow | undefined {
    const id = this.byDedupe.get(key);
    return id ? this.sourceItems.get(id) : undefined;
  }
  getWorkItem(id: string) {
    const w = this.workItems.get(id);
    return w ? this.digest(w) : undefined;
  }
  listWorkItems() {
    return [...this.workItems.values()].map((w) => ({ ...this.digest(w), landedAs: w.landedAs, newBadge: w.newBadge, confidence: w.confidence, due: w.due, ...(w.statusReason ? { statusReason: w.statusReason } : {}) }));
  }
  evidenceFor(workItemId: string): EvidenceRow[] {
    return [...this.evidence.values()].filter((e) => e.workItemId === workItemId);
  }
  allEvidence(): EvidenceRow[] {
    return [...this.evidence.values()];
  }
  listRuns(scope?: ScopeKey): RunRow[] {
    const sid = scope ? scopeId(scope) : undefined;
    return [...this.runs.values()].filter((r) => !sid || r.scopeId === sid);
  }
  getRun(id: string): RunRow | undefined {
    return this.runs.get(id);
  }
  ledger(scope?: ScopeKey): LedgerRow[] {
    const sid = scope ? scopeId(scope) : undefined;
    return this.ledgerRows.filter((l) => !sid || l.scopeId === sid);
  }
  latestHealth(connector: ConnectorId): ConnectorHealthProbe | undefined {
    const h = this.healthLog.get(connector);
    return h?.[h.length - 1];
  }
  healthHistory(connector: ConnectorId): ConnectorHealthProbe[] {
    return this.healthLog.get(connector) ?? [];
  }
  spendToday(): number {
    const day = this.dayKey(this.clock.now());
    return this.spend.filter((s) => s.day === day).reduce((a, s) => a + s.costUsd, 0);
  }
  listBriefs() {
    return [...this.briefs.values()];
  }
  unlinkedRow(sourceItemId: string): UnlinkedRow | undefined {
    return this.unlinked.get(sourceItemId);
  }
  counts() {
    return {
      sourceItems: this.sourceItems.size,
      workItems: this.workItems.size,
      evidence: this.evidence.size,
      initiatives: this.initiatives.size,
      runs: this.runs.size,
      ledger: this.ledgerRows.length,
      unlinked: [...this.unlinked.values()].filter((u) => !this.hasEvidence(u.sourceItemId)).length,
    };
  }

  /**
   * Id-agnostic canonical dump of the durable state, for "same final state" assertions: source items by
   * dedupeKey, work items by origin key, evidence by (item origin key, source dedupeKey, role), cursors.
   */
  stateDigest(): string {
    const siKey = (id: string) => this.sourceItems.get(id)?.dedupeKey ?? id;
    const wiKey = (id: string) => {
      const w = this.workItems.get(id);
      return w ? w.originKey.replace(/si_\d+/g, (m) => siKey(m)) : id;
    };
    const items = [...this.sourceItems.values()].map((s) => [s.dedupeKey, s.contentHash, s.revision]).sort();
    const works = [...this.workItems.values()].map((w) => [wiKey(w.id), w.kind, w.title, w.state, w.landedAs]).sort();
    const ev = [...this.evidence.values()].map((e) => [wiKey(e.workItemId), siKey(e.sourceItemId), e.role]).sort();
    const cur = [...this.cursors.entries()].sort();
    const unl = [...this.unlinked.values()]
      .filter((u) => !this.hasEvidence(u.sourceItemId))
      .map((u) => [siKey(u.sourceItemId), u.attempts])
      .sort();
    return JSON.stringify({ items, works, ev, cur, unl });
  }

  // ------------------------------------------------------------------ internals

  protected mustRunning(runId: string): RunRow {
    const run = this.runs.get(runId);
    if (!run) throw new RunStateError(`unknown run ${runId}`);
    if (run.status !== 'running') throw new RunStateError(`run ${runId} is ${run.status}`);
    return run;
  }
  protected mustWork(id: string): WorkItemRow {
    const w = this.workItems.get(id);
    if (!w) throw new NotFoundError(`work item ${id}`);
    return w;
  }
  protected mustSource(id: string): SourceItemRow {
    const s = this.sourceItems.get(id);
    if (!s) throw new NotFoundError(`source item ${id}`);
    return s;
  }
  protected hasEvidence(sourceItemId: string): boolean {
    for (const e of this.evidence.values()) if (e.sourceItemId === sourceItemId) return true;
    return false;
  }
  protected isLinkable(w: WorkItemRow, now: number): boolean {
    if (w.state === 'dismissed' || w.state === 'merged') return false;
    if (w.state === 'done') {
      const doneAt = toMs(w.doneAt ?? w.lastEvidenceAt);
      return doneAt == null || now - doneAt <= this.reopenWindowMs;
    }
    return true;
  }
  protected markPending(run: RunRow, workItemId: string) {
    const set = this.pendingReeval.get(run.scopeId) ?? new Set<string>();
    set.add(workItemId);
    this.pendingReeval.set(run.scopeId, set);
  }
  protected addEvidence(run: RunRow, w: WorkItemRow, s: SourceItemRow, role: EvidenceRole, confidence: Confidence, reason: string): EvidenceRow {
    const key = `${w.id}|${s.id}|${role}`;
    const existing = this.evidence.get(key);
    if (existing) return existing;
    const row: EvidenceRow = { id: this.id('ev'), workItemId: w.id, sourceItemId: s.id, role, confidence, reason, runId: run.id, skillVersion: run.skillVersion };
    this.evidence.set(key, row);
    // digest update
    if (s.author) for (const p of personKeys(s.author)) w.people.add(p);
    for (const p of s.participants ?? []) for (const k of personKeys(p)) w.people.add(k);
    if (s.threadRef) w.threadRefs.add(s.threadRef);
    for (const f of s.fileRefs ?? []) w.fileRefs.add(normDriveRef(f)); // R13
    for (const a of this.resolveAccounts(s.accountHints ?? [])) w.accounts.add(a);
    if (!w.lastEvidenceAt || s.occurredAt > w.lastEvidenceAt) w.lastEvidenceAt = s.occurredAt;
    this.markPending(run, w.id);
    return row;
  }
  protected resolveAccounts(hints: string[]): string[] {
    const out = new Set<string>();
    const aliases = this.profile.aliases?.accounts ?? [];
    for (const h of hints) {
      const lower = h.toLowerCase();
      const hit = aliases.find((a) => a.accountId === h || a.names.some((n) => n.toLowerCase() === lower));
      out.add(hit ? hit.accountId : h);
    }
    return [...out];
  }
  protected committedRanges(sid: string): Range[] {
    return this.ledgerRows
      .filter((l) => l.scopeId === sid && l.outcome === 'complete' && l.fromMs != null && l.toMs != null)
      .map((l) => ({ from: l.fromMs!, to: l.toMs! }));
  }
  protected advanceCursor(sid: string) {
    const current = this.cursors.get(sid);
    const merged = mergeRanges(this.committedRanges(sid), this.tol);
    if (!merged.length) {
      // No ranged coverage (e.g. record-only scopes): accept the newest proposed cursor that moves forward.
      const latest = this.latestProposed(sid, current, Number.POSITIVE_INFINITY);
      if (latest) this.cursors.set(sid, latest);
      return;
    }
    const base = current ? toMs(current.at)! : merged[0]!.from;
    const seg = merged.find((r) => r.from <= base + this.tol && base <= r.to + this.tol);
    const reach = seg ? seg.to : base;
    const next = this.latestProposed(sid, current, reach);
    if (next) this.cursors.set(sid, next);
  }
  protected latestProposed(sid: string, current: Cursor | undefined, reach: number): Cursor | undefined {
    const curAt = current ? toMs(current.at)! : Number.NEGATIVE_INFINITY;
    let best: Cursor | undefined;
    let bestAt = curAt;
    for (const r of this.runs.values()) {
      if (r.scopeId !== sid || r.status !== 'succeeded' || !r.cursorAfter) continue;
      const at = toMs(r.cursorAfter.at)!;
      if (at > bestAt && at <= reach + this.tol) {
        best = r.cursorAfter;
        bestAt = at;
      }
    }
    return best ? { ...best } : undefined;
  }
  protected digest(w: WorkItemRow): OpenItemDigestExt {
    const d: OpenItemDigest = {
      workItemId: w.id,
      initiativeId: w.initiativeId,
      kind: w.kind,
      title: w.title,
      purpose: w.purpose,
      state: w.state,
      people: [...w.people],
      accounts: [...w.accounts],
      keywords: [...w.keywords].slice(0, 12),
      threadRefs: [...w.threadRefs],
      fileRefs: [...w.fileRefs],
      lastEvidenceAt: w.lastEvidenceAt,
    };
    return {
      ...d,
      ...(w.resolution ? { resolution: w.resolution } : {}),
      ...(w.involvement ? { involvement: w.involvement } : {}),
      ...(w.handedOffTo ? { handedOffTo: w.handedOffTo } : {}),
      ...(w.expected ? { expected: w.expected } : {}),
    };
  }
}
