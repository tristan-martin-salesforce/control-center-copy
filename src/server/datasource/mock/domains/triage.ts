/**
 * The mock DataSource, triage domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import { ITEM_PATCH_LOCK, I, Res } from '../shared';
import type { MockCtx } from '../ctx';
import type { TriageItem, WorkItemRecord } from '@/contract';
import { invalid, notFound } from '@/server/errors';
import { CLOSED_WINDOW_DAYS } from '@/engines/home/closed';
import { closeUndoOf, hydrateItem, itemRef } from '../views';
import { triageView } from '@/server/views/triage';

export class MockTriage {
  constructor(private readonly ctx: MockCtx) {}

  async getTriage(_i: I<'getTriage'>): Promise<Res<'getTriage'>> {
    // SETTLE-1: the Closed for you group (last 14 days), each with the undo id of its latest close (as Today's rail)
    return triageView(this.ctx.store, { sinceMs: this.ctx.now().getTime() - CLOSED_WINDOW_DAYS * 86_400_000, undoOf: closeUndoOf(this.ctx.audit) });
  }

  private triageItem(tid: string): TriageItem {
    const found = triageView(this.ctx.store).groups.flatMap((g) => g.items).find((i) => i.id === tid);
    if (found) return found;
    throw notFound('Triage item', tid);
  }

  private triageView(tid: string, fallback: TriageItem): TriageItem {
    const w = this.ctx.store.get('workItems', tid);
    const m = this.ctx.store.get('missedOpps', tid);
    const q = this.ctx.store.get('mappings', tid);
    return { ...fallback, workItem: w ? hydrateItem(this.ctx.store, w) : fallback.workItem, missedOpp: m ?? fallback.missedOpp, mapping: q ?? fallback.mapping };
  }

  async acceptTriage({ params, body }: I<'acceptTriage'>): Promise<Res<'acceptTriage'>> {
    const t = this.triageItem(params.id);
    let auditId: string | null = null;
    if (t.kind === 'work_item') {
      const cur = this.ctx.item(t.id);
      const locks = new Set(cur.userLockedFields);
      for (const k of Object.keys(body.edits ?? {})) if (ITEM_PATCH_LOCK[k]) locks.add(ITEM_PATCH_LOCK[k]);
      const next = this.ctx.bump({ ...cur, ...(body.edits ?? {}), state: 'open', userLockedFields: [...locks] } as WorkItemRecord);
      auditId = this.ctx.tx({ actor: 'user', action: 'triage.accept', summary: `Accepted: ${cur.title}`, entity: itemRef(cur) }, (tx) => tx.put('workItems', next)).entry?.id ?? null;
    } else if (t.kind === 'missed_opp') {
      auditId = this.ctx.ds.deals.claimMissedTx(t.missedOpp!).entry?.id ?? null;
    } else {
      const q = t.mapping!;
      if (!body.choiceId || !q.choices.some((c) => c.id === body.choiceId)) throw invalid('Pick one of the choices (choiceId)', { choices: q.choices });
      auditId = this.ctx.tx({ actor: 'user', action: 'triage.map', summary: `Mapped ${q.subject.label}`, entity: { type: 'triage_mapping', id: q.id, label: q.question } }, (tx) => tx.put('mappings', { ...q, status: 'answered', answerId: body.choiceId! })).entry?.id ?? null;
    }
    return { entity: this.triageView(t.id, t), auditId };
  }

  async dismissTriage({ params, body }: I<'dismissTriage'>): Promise<Res<'dismissTriage'>> {
    const t = this.triageItem(params.id);
    const now = this.ctx.nowIso();
    const r = this.ctx.tx({ actor: 'user', action: 'triage.dismiss', summary: `Dismissed: ${t.title}`, entity: { type: t.kind === 'work_item' ? 'work_item' : t.kind === 'missed_opp' ? 'missed_opp' : 'triage_mapping', id: t.id, label: t.title } }, (tx) => {
      if (t.kind === 'work_item') {
        const cur = this.ctx.item(t.id);
        tx.put('workItems', this.ctx.bump({ ...cur, state: 'dismissed', dismissed: { reason: 'other', note: body.note ? `${body.reason}: ${body.note}` : body.reason, at: now } }));
      } else if (t.kind === 'missed_opp') tx.put('missedOpps', { ...t.missedOpp!, status: 'dismissed', dismissReason: body.reason });
      else tx.put('mappings', { ...t.mapping!, status: 'dismissed' });
    });
    return { entity: this.triageView(t.id, t), auditId: r.entry?.id ?? null };
  }

  async mergeTriage({ params, body }: I<'mergeTriage'>): Promise<Res<'mergeTriage'>> {
    const t = this.triageItem(params.id);
    if (t.kind !== 'work_item') throw invalid('Only work items can be merged');
    const src = this.ctx.item(t.id);
    const into = this.ctx.item(body.intoId);
    if (src.id === into.id) throw invalid('Cannot merge an item into itself');
    const r = this.ctx.tx({ actor: 'user', action: 'triage.merge', summary: `Merged "${src.title}" into "${into.title}"`, entity: itemRef(src), related: [itemRef(into)] }, (tx) => {
      let moved = 0;
      for (const e of this.ctx.store.all('evidence')) if (e.workItemId === src.id) {
        tx.put('evidence', { ...e, workItemId: into.id, isNew: true });
        moved++;
      }
      tx.put('workItems', this.ctx.bump({ ...src, state: 'dismissed', dismissed: { reason: 'other', note: `Merged into ${into.title}`, at: this.ctx.nowIso() } }));
      tx.put('workItems', this.ctx.bump({ ...into, newEvidenceCount: into.newEvidenceCount + Math.max(1, moved), sources: [...into.sources, ...src.sources.filter((s) => !into.sources.some((x) => x.label === s.label))] }));
    });
    return { entity: this.triageView(t.id, t), auditId: r.entry?.id ?? null, receipt: this.ctx.receiptFrom(r.entry, r.ops, 'user', 'Merged') };
  }
}
