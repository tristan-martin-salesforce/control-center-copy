/**
 * The mock DataSource, today domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import { personaOf, featureActive } from '@/personas';
import type { Actor, PriorityPolicy } from '@/contract';
import { notFound } from '@/server/errors';
import { ucSyncView } from '@/server/deals/use-cases';
import { planUseCases } from '@/engines/activity/use-cases';
import { dcWaitingCount, ucWaitingCount, type WaitingForCanvas } from '@/lib/waiting-work';
import { pendingChatCards } from '@/server/chat/outputs';
import { getHomeMock } from '../home';
import { vdpNeedYouCount } from '@/engines/vdp/status';
import { computeRanking, derivedPriority, storedOrder, toRankRows } from '../rank';
import { Tx } from '../store';
import { asReadModel, buildSince, closeUndoOf, mockCapacity } from '../views';
import { interimRanker } from '../../db/rank';
import { todayView } from '@/server/views/today';

export class MockToday {
  constructor(private readonly ctx: MockCtx) {}

  rankAllDirect() {
    const now = this.ctx.now();
    const policy = this.ctx.store.settings().policy;
    const scored = computeRanking(this.ctx.store, policy, now);
    const byId = new Map(scored.map((s, i) => [s.id, { ...s, rank: i + 1 }]));
    for (const w of this.ctx.store.all('workItems')) {
      const s = byId.get(w.id);
      this.ctx.store._set('workItems', s ? { ...w, rank: s.rank, score: s.score, rankReasons: s.reasons, priority: derivedPriority(s.rank) } : { ...w, rank: null, score: null, priority: derivedPriority(null) });
    }
    const meta = this.ctx.store.meta();
    this.ctx.store._set('meta', { ...meta, rankedAt: now.toISOString(), policyRankVersion: policy.version });
  }

  async getToday(_i: I<'getToday'>): Promise<Res<'getToday'>> {
    const t = this.todayOf(this.ctx.now());
    // D-59: the Time badge also counts the VDPs that need you (quiet; only approvals waiting are loud); 2026-11-13 audit
    // C2: and the DCs and use cases waiting for a canvas; C8: the Assistant's staged cards
    const v = this.ctx.ds.vdp.vdpHome();
    return { ...t, navCounts: { ...t.navCounts, vdpOpen: v ? vdpNeedYouCount(v.summary) : 0, waitingForCanvas: this.waitingForCanvas(), assistantPending: pendingChatCards(this.ctx.ds.be6.plans.values()) } };
  }

  /**
   * The shared view (src/server/views/today.ts) over the store. The mock's ranker is its own scorer (the interim
   * ranker: the stored order, a waiting item feeding a meeting within 3 h takes the third slot); its audit log gives
   * the since-you-left entries and each close's Undo.
   */
  private todayOf(now: Date): Res<'getToday'> {
    const store = this.ctx.store;
    const rank = interimRanker.today(asReadModel(store), storedOrder(store), now);
    const since = buildSince(store, this.ctx.audit.entries, store.meta().lastActiveAt, now);
    return todayView(store, { rank, since, closeUndo: closeUndoOf(this.ctx.audit), capacity: () => mockCapacity(store, now) }, now);
  }

  /** 2026-11-13 audit C2: DC requests and VDP use cases waiting for a canvas (the db's rule; src/lib/waiting-work.ts). */
  waitingForCanvas(): WaitingForCanvas {
    const persona = personaOf(this.ctx.store.settings());
    return {
      dcs: featureActive(persona, 'dealContributions') ? dcWaitingCount(this.ctx.ds.deals.dcRequests()) : 0,
      useCases: featureActive(persona, 'vdp') ? ucWaitingCount(ucSyncView(planUseCases(this.ctx.ds.deals.ucPlanInput()), null).counts) : 0,
    };
  }

  async getHome(i: I<'getHome'>): Promise<Res<'getHome'>> { return getHomeMock(this.ctx.ds, i); } // prettier-ignore

  async rerankToday(_i: I<'rerankToday'>): Promise<Res<'rerankToday'>> {
    const { entry, result } = this.rerankAll('user', 'today.rerank', 'Applied re-rank');
    return { entity: result, auditId: entry?.id ?? null };
  }

  rerankAll(actor: Actor, action: string, summary: string, policy?: PriorityPolicy, extra?: (tx: Tx) => void, entity?: { type: 'settings' | 'policy'; id: string; label: string }) {
    const now = this.ctx.now();
    this.ctx.ds.priority.recordRun(this.ctx.store, now, policy); // priority@2 shadow (db parity: the run records both orders, over the read model as the re-rank starts)
    const before = storedOrder(this.ctx.store).map((i) => i.id);
    const label = policy ?? this.ctx.store.settings().policy;
    let scored: ReturnType<typeof computeRanking> = [];
    const r = this.ctx.tx({ actor, action, summary, entity: entity ?? { type: 'policy', id: label.id, label: `Ranking (policy v${label.version})` } }, (tx) => {
      extra?.(tx);
      const pol = policy ?? this.ctx.store.settings().policy;
      scored = computeRanking(this.ctx.store, pol, now);
      const byId = new Map(scored.map((s, i) => [s.id, { ...s, rank: i + 1 }]));
      for (const w of this.ctx.store.all('workItems')) {
        const s = byId.get(w.id);
        const next = s ? { ...w, rank: s.rank, score: s.score, rankReasons: s.reasons, priority: derivedPriority(s.rank) } : { ...w, rank: null, score: null, priority: derivedPriority(null) };
        if (next.rank !== w.rank || next.score !== w.score || JSON.stringify(next.rankReasons) !== JSON.stringify(w.rankReasons)) tx.put('workItems', next);
      }
      tx.put('meta', { ...this.ctx.store.meta(), rankedAt: now.toISOString(), policyRankVersion: pol.version });
    });
    const top = toRankRows(this.ctx.store, scored, before, 10);
    return { ...r, result: { rankedAt: now.toISOString(), changed: top.filter((t) => t.moved !== 0).length, top } };
  }

  /** priority@2: Today's "Preview new ranking" (db parity; nothing is written). */
  async getPriorityPreview(_i: I<'getPriorityPreview'>): Promise<Res<'getPriorityPreview'>> {
    return this.ctx.ds.priority.preview(this.ctx.store, this.ctx.now());
  }

  /** Health ▸ the suggested priority rule (in memory for the mock session). */
  async decidePriorityRule({ params, body }: I<'decidePriorityRule'>): Promise<Res<'decidePriorityRule'>> {
    const rule = this.ctx.ds.priority.decide(params.id, body.decision, this.ctx.now());
    if (!rule) throw notFound('Priority rule', params.id);
    this.ctx.bus.publish({ topic: 'health', ids: [rule.id], reason: `priority.rule.${body.decision}` });
    return { entity: rule, auditId: null };
  }

  /** Ops: the mock has one user and no queue; it re-ranks in place. */
  async rerankAllUsers(_i: I<'rerankAllUsers'>): Promise<Res<'rerankAllUsers'>> {
    return { users: 1, enqueued: 0 };
  }
}
