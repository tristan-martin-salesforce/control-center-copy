/**
 * The db DataSource, triage domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import { ITEM_PATCH_LOCK, WHOLE, I, Res } from '../shared';
import type { DbCtx } from '../ctx';
import { eq } from 'drizzle-orm';
import type { TriageItem, WorkItemLockableField, WorkItemRecord } from '@/contract';
import { changeSets } from '@/db/schema';
import { CLOSED_WINDOW_DAYS } from '@/engines/home/closed';
import { invalid, notFound } from '@/server/errors';
import { closeEntries, receiptFromChangeSet } from '../audit';
import { uuidFor } from '../ids';
import type { ReadModel } from '../model';
import { TRIAGE } from '../reads/scope';
import { updateFinding, writeMapping } from '../store/misc';
import { logTransition, updateEvidence } from '../store/work';
import { hydrateItem } from '../views';
import { triageView } from '@/server/views/triage';

export class DbTriage {
  constructor(private readonly ctx: DbCtx) {}

  async getTriage(_i: I<'getTriage'>): Promise<Res<'getTriage'>> {
    return this.ctx.read(TRIAGE, (m) => this.triagePage(m));
  }

  private async triagePage(m: ReadModel): Promise<Res<'getTriage'>> {
    // SETTLE-1: the Closed for you group (last 14 days) takes each close's Undo from the same Q6 lookup Today's rail uses
    const sinceMs = this.ctx.now().getTime() - CLOSED_WINDOW_DAYS * 86_400_000;
    const closeUndo = await closeEntries(this.ctx.db, m.ctx.userId, new Date(sinceMs));
    // DEEP-1: every suggestion, from the model (Q9 stops at 100 rows, and the Still needed? group can pass that)
    return triageView(m, { sinceMs, undoOf: (id) => closeUndo.get(id) ?? closeUndo.get(uuidFor(id)) ?? null });
  }

  private triageItem(m: ReadModel, tid: string): TriageItem {
    const found = triageView(m).groups.flatMap((g) => g.items).find((i) => i.id === tid);
    if (found) return found;
    throw notFound('Triage item', tid);
  }

  private async triageView(tid: string, fallback: TriageItem): Promise<TriageItem> {
    const m = await this.ctx.model(WHOLE);
    const w = m.get('workItems', tid);
    const mo = m.get('missedOpps', tid);
    const q = m.get('mappings', tid);
    return { ...fallback, workItem: w ? hydrateItem(m, w) : fallback.workItem, missedOpp: mo ?? fallback.missedOpp, mapping: q ?? fallback.mapping };
  }

  async acceptTriage({ params, body }: I<'acceptTriage'>): Promise<Res<'acceptTriage'>> {
    let t: TriageItem | null = null;
    const r = await this.ctx.mutate({ action: 'triage.accept', summary: 'Accepted', entity: { type: 'work_item', id: params.id } }, async (w, model) => {
      t = this.triageItem(model, params.id);
      if (t.kind === 'work_item') {
        const cur = this.ctx.item(model, t.id);
        const locks = new Set(cur.userLockedFields);
        const newly: WorkItemLockableField[] = [];
        for (const k of Object.keys(body.edits ?? {})) if (ITEM_PATCH_LOCK[k]) {
          locks.add(ITEM_PATCH_LOCK[k]);
          newly.push(ITEM_PATCH_LOCK[k]);
        }
        await w.tx.update(changeSets).set({ summary: `Accepted: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
        await this.ctx.writeItem(w, model, cur, { ...cur, ...(body.edits ?? {}), state: 'open', userLockedFields: [...locks] } as WorkItemRecord, { bump: true, lock: newly });
        await logTransition(w, cur.id, cur.state, 'open', 'Accepted from triage');
      } else if (t.kind === 'missed_opp') {
        // one Claim verb: a DC request (100%, the role's DC role, the evidence), editable in Deals ▸ DCs
        await this.ctx.ds.deals.claimIn(w, model, t.missedOpp!);
        await w.tx.update(changeSets).set({ summary: `Claimed ${t.missedOpp!.oppName}`, entityType: 'missed_opp' }).where(eq(changeSets.id, w.cs.id));
      } else {
        const q = t.mapping!;
        if (!body.choiceId || !q.choices.some((c) => c.id === body.choiceId)) throw invalid('Pick one of the choices (choiceId)', { choices: q.choices });
        await w.tx.update(changeSets).set({ summary: `Mapped ${q.subject.label}`, entityType: 'triage_mapping' }).where(eq(changeSets.id, w.cs.id));
        await writeMapping(w, { ...q, status: 'answered', answerId: body.choiceId });
      }
    });
    return { entity: await this.triageView(params.id, t!), auditId: r.auditId };
  }

  async dismissTriage({ params, body }: I<'dismissTriage'>): Promise<Res<'dismissTriage'>> {
    let t: TriageItem | null = null;
    const r = await this.ctx.mutate({ action: 'triage.dismiss', summary: 'Dismissed', entity: { type: 'work_item', id: params.id } }, async (w, model) => {
      t = this.triageItem(model, params.id);
      const now = w.now.toISOString();
      await w.tx.update(changeSets).set({ summary: `Dismissed: ${t.title}`, entityType: t.kind === 'work_item' ? 'work_item' : t.kind === 'missed_opp' ? 'missed_opp' : 'triage_mapping' }).where(eq(changeSets.id, w.cs.id));
      if (t.kind === 'work_item') {
        const cur = this.ctx.item(model, t.id);
        await this.ctx.writeItem(w, model, cur, { ...cur, state: 'dismissed', dismissed: { reason: 'other', note: body.note ? `${body.reason}: ${body.note}` : body.reason, at: now } }, { bump: true });
        await logTransition(w, cur.id, cur.state, 'dismissed', body.reason);
      } else if (t.kind === 'missed_opp') await updateFinding(w, t.missedOpp!, { ...t.missedOpp!, status: 'dismissed', dismissReason: body.reason });
      else await writeMapping(w, { ...t.mapping!, status: 'dismissed' });
    });
    return { entity: await this.triageView(params.id, t!), auditId: r.auditId };
  }

  async mergeTriage({ params, body }: I<'mergeTriage'>): Promise<Res<'mergeTriage'>> {
    let t: TriageItem | null = null;
    const r = await this.ctx.mutate({ action: 'triage.merge', summary: 'Merged', entity: { type: 'work_item', id: params.id } }, async (w, model) => {
      t = this.triageItem(model, params.id);
      if (t.kind !== 'work_item') throw invalid('Only work items can be merged');
      const src = this.ctx.item(model, t.id);
      const into = this.ctx.item(model, body.intoId);
      if (src.id === into.id) throw invalid('Cannot merge an item into itself');
      await w.tx.update(changeSets).set({ summary: `Merged "${src.title}" into "${into.title}"` }).where(eq(changeSets.id, w.cs.id));
      let moved = 0;
      for (const e of model.all('evidence')) if (e.workItemId === src.id) {
        await updateEvidence(w, e, { ...e, workItemId: into.id, isNew: true }, into.seenAt);
        moved++;
      }
      await this.ctx.writeItem(w, model, src, { ...src, state: 'dismissed', dismissed: { reason: 'other', note: `Merged into ${into.title}`, at: w.now.toISOString() } }, { bump: true });
      await logTransition(w, src.id, src.state, 'dismissed', `Merged into ${into.title}`);
      await this.ctx.writeItem(w, model, into, { ...into, newEvidenceCount: into.newEvidenceCount + Math.max(1, moved), sources: [...into.sources, ...src.sources.filter((s) => !into.sources.some((x) => x.label === s.label))] }, { bump: true });
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: await this.triageView(params.id, t!), auditId: r.auditId, receipt: await receiptFromChangeSet(this.ctx.db, r.auditId, m, 'user', 'Merged', this.ctx.now().toISOString()) };
  }
}
