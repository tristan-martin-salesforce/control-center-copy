/**
 * The mock DataSource, needs domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import type { NeedDecision } from '@/contract';
import { needDecisionLabel, planNeedDecisions } from '@/server/deals/needs';
import { needDecisionOrder, needKey } from '@/lib/need-decisions';
import { decideNeedRowVia, listNeedsVia } from '../needs';
import { mockCallsOf } from '../attribution';

export class MockNeeds {
  constructor(private readonly ctx: MockCtx) {}

  // ---- Needs you: Snooze / Not needed decisions (src/contract/needs.ts) ------------------------------------
  async listNeedDecisions(_i: I<'listNeedDecisions'>): Promise<Res<'listNeedDecisions'>> {
    return { decisions: this.ctx.store.all('needDecisions').sort(needDecisionOrder) };
  }

  async decideNeed({ body }: I<'decideNeed'>): Promise<Res<'decideNeed'>> {
    const ds = planNeedDecisions(body, this.ctx.now(), this.ctx.store.all('opps'), this.ctx.store.settings().profile.timezone || this.ctx.store.meta().timezone, mockCallsOf(this.ctx.store, this.ctx.nowIso()).calls);
    const { entry } = this.ctx.tx({ actor: 'user', action: 'needs.decide', summary: needDecisionLabel(ds), entity: { type: body.rule === 'dc_gap' ? 'opportunity' : 'account', id: body.subjectIds[0]!, label: ds[0]?.label ?? body.subjectIds[0]! } }, (tx) => {
      for (const d of ds) tx.put('needDecisions', d);
    });
    return { entity: { decisions: ds }, auditId: entry?.id ?? null };
  }

  // ---- The Needs-you queue (01 R1, D-86; db/needs.ts): a composition over the methods above ----------------
  async listNeeds(_i: I<'listNeeds'>): Promise<Res<'listNeeds'>> {
    return listNeedsVia(this.ctx.ds, this.ctx.now());
  }

  async decideNeedRow(i: I<'decideNeedRow'>): Promise<Res<'decideNeedRow'>> {
    return decideNeedRowVia(this.ctx.ds, this.ctx.now(), i);
  }

  async clearNeedDecision({ body }: I<'clearNeedDecision'>): Promise<Res<'clearNeedDecision'>> {
    const gone = [...new Set(body.subjectIds)].map((sid) => this.ctx.store.get('needDecisions', needKey(body.rule, sid))).filter((d): d is NeedDecision => !!d);
    if (!gone.length) return { entity: { decisions: [] }, auditId: null };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'needs.clear', summary: `Back on the list: ${gone.map((d) => d.label ?? d.subjectId).join(', ')}`.slice(0, 200), entity: { type: body.rule === 'dc_gap' ? 'opportunity' : 'account', id: gone[0]!.subjectId, label: gone[0]!.label ?? gone[0]!.subjectId } }, (tx) => {
      for (const d of gone) tx.remove('needDecisions', needKey(d.rule, d.subjectId));
    });
    return { entity: { decisions: gone.sort(needDecisionOrder) }, auditId: entry?.id ?? null };
  }
}
