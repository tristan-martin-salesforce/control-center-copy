/**
 * The mock DataSource's context (R7): what every domain module shares: the store and its audit log, the bus, the
 * clock, the spend governor, the unit of work (`tx`) and its publish / receipt helpers.
 */
import type { MockDataSource } from './index';
import type { Actor, AuditEntry, EntityRef, EntityType, Evidence, EvidenceRole, LiveNotify, LiveTopic, Receipt, ReceiptChange, SourceRef, WorkItemRecord } from '@/contract';
import { MemorySpendStore, SpendGovernor } from '@/llm/spend';
import { conflict } from '@/server/errors';
import { MemoryEventBus } from './bus';
import { MockClock } from './clock';
import { isClosedItemState, isWithdrawableDraft, withdrawnReason } from '@/outbox/withdraw';
import { COLLECTION_TOPICS, MockAuditLog, Store, Tx, type CollectionName, type RowOp } from './store';
import { hrefFor } from './views';
import { MockDelays, id, uniq, labelOf } from './shared';

interface TxMeta {
  actor: Actor;
  action: string;
  summary: string;
  entity: EntityRef;
  related?: EntityRef[];
  undoable?: boolean;
  /** false: no audit entry (read markers, simulations). */
  audit?: boolean;
  coalesceKey?: string;
  undoOf?: string | null;
  stepId?: string;
  notify?: LiveNotify;
}

const COL_TYPE: Record<CollectionName, EntityType> = {
  meta: 'settings',
  settings: 'settings',
  spend: 'settings',
  people: 'person',
  accounts: 'account',
  opps: 'opportunity',
  missedOpps: 'missed_opp',
  initiatives: 'initiative',
  workItems: 'work_item',
  evidence: 'work_item',
  nbas: 'nba',
  drafts: 'draft',
  proposals: 'proposal',
  assets: 'asset',
  events: 'calendar_event',
  slots: 'calendar_event',
  agentRuns: 'agent_run',
  toolAdapters: 'tool_adapter',
  toolRuns: 'tool_run',
  activity: 'activity_entry',
  timeBlocks: 'calendar_event',
  briefs: 'brief',
  watches: 'watch',
  connectors: 'connector',
  scanRuns: 'connector',
  jobs: 'job',
  eventLog: 'event_log',
  chatThreads: 'chat_thread',
  mappings: 'triage_mapping',
  policyVersions: 'policy',
  dcRequests: 'opportunity',
  needDecisions: 'opportunity',
  timeDismissRules: 'activity_entry',
  vdpIdentity: 'vdp',
  rowOverrides: 'draft',
  learnedRules: 'settings',
  dcSuggestions: 'opportunity',
  useCaseCandidates: 'opportunity',
};

export class MockCtx {
  constructor(readonly ds: MockDataSource) {}

  // set once by MockDataSource's constructor (the seed's clock comes first)
  bus!: MemoryEventBus;
  clock!: MockClock;
  delays!: MockDelays;
  store!: Store;
  audit!: MockAuditLog;
  timers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * The spend governor over memory (src/llm/spend): the Assistant's per-message holds and asks, the same answer route
   * as the db; booked spend and the lines come from the mock's spend projection and settings.
   */
  readonly spendGov = new SpendGovernor(
    new MemorySpendStore({
      now: () => this.now(),
      day: () => {
        const sp = this.store.spend();
        return { spentUsd: sp.today.usd, softUsd: sp.today.softBudgetUsd, hardUsd: sp.today.hardCapUsd };
      },
    }),
  );

  now(): Date {
    return this.clock.now();
  }
  nowIso(): string {
    return this.now().toISOString();
  }

  later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (err) {
        console.error('[mock] deferred task failed:', (err as Error).message);
      }
    }, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
    this.timers.add(t);
  }

  refFor(col: CollectionName, v: unknown): EntityRef {
    const o = v as Record<string, unknown>;
    const type = COL_TYPE[col];
    const rid = col === 'evidence' ? String(o.workItemId) : col === 'chatThreads' ? String((o.thread as { id: string }).id) : String(o.id ?? 'current');
    return { type, id: rid, label: labelOf(v) || rid, href: hrefFor({ type, id: rid }) };
  }

  /** Unit of work: apply fn, record audit (with inverse row images), publish live events. Rolls back on throw. */
  tx<R>(m: TxMeta, fn: (tx: Tx) => R): { result: R; entry: AuditEntry | null; ops: RowOp[] } {
    const tx = new Tx(this.store);
    let result: R;
    try {
      result = fn(tx);
      // Undo / redo restore row images exactly (the db's undoChangeSet does too): no withdrawal there.
      if (!m.undoOf) this.withdrawClosedDrafts(tx);
    } catch (err) {
      for (const op of tx.ops().reverse()) {
        if (op.before === null) this.store._delete(op.col, op.id);
        else this.store._set(op.col, op.before as never);
      }
      throw err;
    }
    const ops = tx.ops();
    if (!ops.length) return { result, entry: null, ops };
    const entry =
      m.audit === false
        ? null
        : this.audit.record({
            at: this.nowIso(),
            actor: m.actor,
            action: m.action,
            summary: m.summary,
            entity: m.entity,
            related: m.related ?? uniq(ops.map((o) => `${o.col}:${o.id}`)).slice(0, 12).map((k) => {
              const op = ops.find((o) => `${o.col}:${o.id}` === k)!;
              return this.refFor(op.col, op.after ?? op.before);
            }).filter((r) => !(r.type === m.entity.type && r.id === m.entity.id)),
            ops,
            undoable: m.undoable ?? true,
            undoOf: m.undoOf ?? null,
            coalesceKey: m.coalesceKey,
          });
    this.publishOps(ops, m.action, m.stepId, m.notify, !!entry);
    return { result, entry, ops };
  }

  /**
   * OUTBOX-W (parity with the db's updateWorkItem): an item this unit of work moved into done / dismissed withdraws its
   * pending reply drafts in the same entry (src/outbox/withdraw.ts). Reopening does not bring them back.
   */
  private withdrawClosedDrafts(tx: Tx): void {
    const closed = tx
      .ops()
      .filter((o) => o.col === 'workItems' && o.before && o.after && isClosedItemState((o.after as WorkItemRecord).state) && !isClosedItemState((o.before as WorkItemRecord).state))
      .map((o) => o.after as WorkItemRecord);
    if (!closed.length) return;
    const now = this.nowIso();
    for (const item of closed) {
      const reason = withdrawnReason(item);
      for (const d of this.store.all('drafts')) {
        if (d.workItemId === item.id && isWithdrawableDraft(d)) tx.put('drafts', { ...d, status: 'discarded', rejectedReason: reason, version: d.version + 1, updatedAt: now });
      }
    }
  }

  private publishOps(ops: RowOp[], reason: string, stepId?: string, notify?: LiveNotify, audited?: boolean) {
    const byTopic = new Map<LiveTopic, Set<string>>();
    for (const op of ops) {
      const ref = this.refFor(op.col, op.after ?? op.before);
      for (const topic of COLLECTION_TOPICS[op.col]) {
        if (!byTopic.has(topic)) byTopic.set(topic, new Set());
        byTopic.get(topic)!.add(ref.id);
      }
    }
    if (audited) byTopic.set('audit', new Set(ops.map((o) => o.id)));
    let first = true;
    for (const [topic, ids] of byTopic) {
      this.bus.publish({ topic, ids: [...ids], reason, ...(stepId ? { scenarioStepId: stepId } : {}), ...(first && notify ? { notify } : {}) });
      first = false;
    }
  }

  publish(topics: LiveTopic[], ids: string[], reason: string) {
    for (const topic of topics) this.bus.publish({ topic, ids, reason });
  }

  receiptFrom(entry: AuditEntry | null, ops: RowOp[], actor: Actor, summary: string, filter?: (op: RowOp, field: string) => boolean): Receipt | undefined {
    if (!entry) return undefined;
    const changes: ReceiptChange[] = [];
    for (const op of ops) {
      if (!op.before || !op.after) continue;
      for (const f of op.fields) {
        if (['version', 'updatedAt', 'savedAt', 'rendered', 'doc', 'rankReasons', 'score', 'priority'].includes(f)) continue;
        if (filter && !filter(op, f)) continue;
        changes.push({
          auditId: entry.id,
          entity: this.refFor(op.col, op.after),
          field: f,
          before: (op.before as Record<string, unknown>)[f] ?? null,
          after: (op.after as Record<string, unknown>)[f] ?? null,
        });
      }
    }
    return { id: id('rcpt'), at: entry.at, actor, summary, changes, staged: false };
  }

  checkVersion(cur: { version: number }, ifVersion: number | undefined, what: string, current: unknown) {
    if (ifVersion !== undefined && cur.version !== ifVersion) throw conflict(what, current);
  }

  item(id: string): WorkItemRecord {
    return this.store.must('workItems', id, 'Work item');
  }

  addEvidence(tx: Tx, workItemId: string, role: EvidenceRole, source: SourceRef, summary: string, isNew = true): Evidence {
    const ev: Evidence = {
      id: id('ev'),
      workItemId,
      role,
      source: { ...source, at: source.at ?? this.nowIso() },
      at: this.nowIso(),
      summary,
      snippet: null,
      author: null,
      isNew,
      confidence: null,
    };
    return tx.put('evidence', ev);
  }

  bump<T extends { version: number; updatedAt?: string }>(v: T): T {
    return { ...v, version: v.version + 1, ...('updatedAt' in v ? { updatedAt: this.nowIso() } : {}) };
  }
}
