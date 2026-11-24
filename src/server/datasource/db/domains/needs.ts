/**
 * The db DataSource, needs domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { NEEDS } from '../reads/scope';
import { withReadMemo } from '../reads/session';
import { decideNeedRowVia, listNeedsVia } from '../needs';
import { needDecisionsOf, writeNeedDecision } from '../store/need-decisions';
import { needDecisionLabel, planNeedDecisions } from '@/server/deals/needs';
import { dbCallsOf } from '../attribution';
import { needDecisionOrder } from '@/lib/need-decisions';

export class DbNeeds {
  constructor(private readonly ctx: DbCtx) {}

  // ---- Needs you: Snooze / Not needed decisions (src/contract/needs.ts; user_settings `cc.need/…`) -----------
  async listNeedDecisions(_i: I<'listNeedDecisions'>): Promise<Res<'listNeedDecisions'>> {
    const m = await this.ctx.model(WHOLE);
    return { decisions: needDecisionsOf(m.ctx.kv) };
  }

  async decideNeed({ body }: I<'decideNeed'>): Promise<Res<'decideNeed'>> {
    const m = await this.ctx.model(WHOLE);
    const ds = planNeedDecisions(body, this.ctx.now(), m.all('opps'), m.settings().profile.timezone || m.meta().timezone, dbCallsOf(m, this.ctx.now().toISOString()).calls);
    const r = await this.ctx.mutate({ action: 'needs.decide', summary: needDecisionLabel(ds), entity: { type: body.rule === 'dc_gap' ? 'opportunity' : 'account', id: body.subjectIds[0]! } }, async (w) => {
      for (const d of ds) await writeNeedDecision(w, d.rule, d.subjectId, d);
    });
    this.ctx.bus.publishTables(['need_decisions'], body.subjectIds, 'needs.decide');
    return { entity: { decisions: ds }, auditId: r.undoable ? r.auditId : null };
  }

  // ---- The Needs-you queue (01 R1, D-86; db/needs.ts): a composition over the methods above ----------------
  async listNeeds(_i: I<'listNeeds'>): Promise<Res<'listNeeds'>> {
    // its ten page reads share ONE model (they loaded one each: 11 loads per request before p4-page-scoped-reads)
    // and inside the read memo, the helpers its providers share (the VDP mirror, my book, DC requests) read once
    return withReadMemo(() => this.ctx.reads.run(NEEDS, () => listNeedsVia(this.ctx.ds, this.ctx.now())));
  }

  async decideNeedRow(i: I<'decideNeedRow'>): Promise<Res<'decideNeedRow'>> {
    return decideNeedRowVia(this.ctx.ds, this.ctx.now(), i);
  }

  async clearNeedDecision({ body }: I<'clearNeedDecision'>): Promise<Res<'clearNeedDecision'>> {
    const m = await this.ctx.model(WHOLE);
    const want = new Set(body.subjectIds);
    const gone = needDecisionsOf(m.ctx.kv).filter((d) => d.rule === body.rule && want.has(d.subjectId));
    if (!gone.length) return { entity: { decisions: [] }, auditId: null };
    const r = await this.ctx.mutate({ action: 'needs.clear', summary: `Back on the list: ${gone.map((d) => d.label ?? d.subjectId).join(', ')}`.slice(0, 200), entity: { type: body.rule === 'dc_gap' ? 'opportunity' : 'account', id: gone[0]!.subjectId } }, async (w) => {
      for (const d of gone) await writeNeedDecision(w, d.rule, d.subjectId, null);
    });
    this.ctx.bus.publishTables(['need_decisions'], body.subjectIds, 'needs.clear');
    return { entity: { decisions: gone.sort(needDecisionOrder) }, auditId: r.undoable ? r.auditId : null };
  }
}
