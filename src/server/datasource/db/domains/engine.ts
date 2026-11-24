/**
 * The db DataSource, engine domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, blankItem } from '../shared';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Resolution, ClosingReason, WorkItemRecord } from '@/contract';
import { changeProposals, changeSets, reopenDecisions, workItemEvidence } from '@/db/schema';
import { applySignal } from '@/engines/closure/machine';
import type { ClosureDecision } from '@/engines/closure/types';
import { DEFAULT_CLOSURE_SETTINGS, type ClosureSettings, type Signal } from '@/engines/types';
import { docFromText, plainText, renderAll } from '../../mock/render';
import { closureItemOf, recordAfterDecision, reopenedFromDone, stateFromEngine } from '../closure';
import { loadKv } from '../ext';
import { uuidFor } from '../ids';
import { engineDraftDoc, updateDraft } from '../store/nba';
import { insertWorkItem, logTransition } from '../store/work';
import { STILL_NEEDED_MARK, staleOnArrival, stillNeededReason } from '@/engines/still-needed';

export class DbEngine {
  constructor(private readonly ctx: DbCtx) {}

  /**
   * DEEP-1 backfill (no rescan): open work that was already over 30 days old when first seen (the rule new asks land
   * by, src/engines/still-needed.ts) moves to Triage's "Still needed?" group. Only items you never touched (no
   * transition or edit of yours); work due after it was first seen stays open. One change set (actor system, undoable
   * as a whole). `apply: false` counts only.
   */
  async stillNeededBackfill(opts: { apply: boolean }): Promise<{ candidates: number; moved: number; auditId: string | null }> {
    const userId = await this.ctx.userId();
    const rows = await this.ctx.db
      .execute<{ id: string; created_at: Date; due_at: Date | null; origin_at: Date | null }>(sql`
        select wi.id, wi.created_at, wi.due_at,
               (select max(s.occurred_at) from work_item_evidence e join source_items s on s.id = e.source_item_id
                 where e.work_item_id = wi.id and e.role = 'origin') as origin_at
          from work_items wi
         where wi.owner_user_id = ${userId} and wi.status in ('open', 'in_progress', 'waiting_on_me')
           and not exists (select 1 from work_item_transitions t where t.work_item_id = wi.id and t.actor_kind = 'user')
           and not exists (select 1 from change_sets c where c.owner_user_id = ${userId} and c.actor_kind = 'user'
                             and c.entity_type in ('work_item', 'work_items') and c.entity_id = wi.id::text)`)
      .then((r) => r.rows);
    const stale = rows.filter((r) => r.origin_at && staleOnArrival({ originAt: new Date(r.origin_at).getTime(), firstSeenAt: new Date(r.created_at).getTime(), dueAt: r.due_at ? new Date(r.due_at).getTime() : null }));
    if (!opts.apply || !stale.length) return { candidates: stale.length, moved: 0, auditId: null };
    let moved = 0;
    const r = await this.ctx.mutate({ action: 'items.still_needed', summary: `${stale.length} old asks moved to Triage: still needed?`, actor: 'system' }, async (w, model) => {
      for (const row of stale) {
        const cur = model.get('workItems', row.id);
        if (!cur || !['open', 'in_progress', 'waiting_on_me'].includes(cur.state)) continue;
        const reason = stillNeededReason(new Date(row.origin_at!).getTime(), new Date(row.created_at).getTime(), 'backfill:DEEP-1');
        await this.ctx.writeItem(w, model, cur, { ...cur, state: 'suggested', closedReason: reason }, { bump: true });
        await logTransition(w, cur.id, cur.state, 'suggested', reason);
        moved++;
      }
    });
    for (const t of ['today', 'home', 'triage', 'items'] as const) this.ctx.bus.publish({ topic: t, ids: [], reason: 'items.still_needed' });
    return { candidates: stale.length, moved, auditId: r.auditId };
  }

  /**
   * SETTLE-1: apply Settle decisions (src/engines/settle/policy.ts). One engine change set per item, so each close
   * has its own Undo in the Auto-closed list. The cited message is linked as evidence (provenance) and the
   * transition does not cite it (Undo deletes the evidence first; a nulled transition would trip the append-only
   * guard). An item whose state moved since it was judged is skipped.
   */
  async settleApply(
    entries: Array<{ itemId: string; expectedState: string; action: 'close' | 'ask_looks_done' | 'ask_still_needed' | 'reopen' | 'wait'; reasonClass: ClosingReason | null; resolution?: Resolution; reason: string; verdict: string; confidence: number; check: string; cite?: { sourceItemId?: string; url?: string; byName?: string; fromMe?: boolean; at?: string }; duplicateOf?: string }>,
  ): Promise<{ applied: Record<string, number>; skipped: number; auditIds: Record<string, string> }> {
    const applied: Record<string, number> = {};
    const auditIds: Record<string, string> = {};
    let skipped = 0;
    for (const e of entries) {
      const summary = e.action === 'close' ? 'Closed for you' : e.action === 'reopen' ? 'Still yours: back to open work' : e.action === 'wait' ? 'Waiting on them: in Chase' : e.action === 'ask_looks_done' ? 'Looks done: confirm' : 'Still needed?';
      try {
        const r = await this.ctx.mutate({ action: `settle.${e.action}`, summary, entity: { type: 'work_item', id: e.itemId }, actor: 'engine' }, async (w, model) => {
          const cur = model.get('workItems', e.itemId);
          if (!cur || cur.state !== e.expectedState) return false;
          await w.tx.update(changeSets).set({ summary: `${summary}: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
          const now = w.now.toISOString();
          let evId: string | null = null;
          if (e.cite?.sourceItemId) {
            const role = e.verdict === 'done_by_you' || e.verdict === 'resolved_by_other' || e.verdict === 'handed_off' ? 'completion' : e.verdict === 'waiting_on_them' ? 'progress' : 'context';
            const ins = await w.tx
              .insert(workItemEvidence)
              .values({ workItemId: uuidFor(cur.id), sourceItemId: e.cite.sourceItemId, role, confidence: Math.max(0, Math.min(1, e.confidence)), extractorId: w.extractorId, rationale: `settle: ${e.verdict}: ${e.reason}`.slice(0, 500), createdBy: 'engine' })
              .onConflictDoNothing()
              .returning({ id: workItemEvidence.id });
            evId = ins[0]?.id ?? null;
          }
          let next: WorkItemRecord;
          if (e.action === 'close') {
            const person = e.resolution === 'done_by_other' || e.resolution === 'handed_off' ? (e.cite && !e.cite.fromMe ? e.cite.byName : undefined) : undefined;
            const resolution: Resolution = e.resolution === 'handed_off' && !person ? 'done_by_me' : (e.resolution ?? 'done_by_me');
            next = {
              ...cur,
              state: 'done',
              doneAt: now,
              doneBy: 'engine',
              closedReason: e.reason,
              likelyDone: null,
              waiting: null,
              snoozedUntil: null,
              resolution,
              resolutionDetail: {
                inferred: true,
                note: e.reason,
                ...(evId ? { evidenceIds: [evId] } : {}),
                ...(person ? { personName: person } : {}),
                ...(e.duplicateOf && (resolution === 'duplicate' || resolution === 'superseded') && model.get('workItems', e.duplicateOf) ? { relatedItemId: e.duplicateOf } : {}),
                ...(e.reasonClass ? { settle: { reason: e.reasonClass, confidence: e.confidence, ...(e.cite?.url ? { sourceUrl: e.cite.url } : {}), check: e.check } } : {}),
              },
              loopedBackIn: null,
            };
          } else if (e.action === 'ask_looks_done') {
            next = { ...cur, state: 'likely_done', likelyDone: { reason: e.reason, evidenceId: evId } };
          } else if (e.action === 'wait') {
            next = { ...cur, state: 'waiting_on_others', closedReason: null, likelyDone: null, waiting: { on: 'others', reason: e.reason, since: e.cite?.at ?? now } };
          } else if (e.action === 'ask_still_needed') {
            next = { ...cur, state: 'suggested', closedReason: `${e.reason}: ${STILL_NEEDED_MARK} (settle)` };
          } else if (cur.state === 'done') {
            // R2: a follow-up shows an item closed for you is still yours: reopened, like the closure machine's reopen.
            next = reopenedFromDone(cur, `Reopened: ${e.cite?.byName && !e.cite.fromMe ? `${e.cite.byName} wrote again` : 'a follow-up after the close'}`, now);
          } else {
            next = { ...cur, state: 'open', closedReason: null };
          }
          await this.ctx.writeItem(w, model, cur, next, { bump: true });
          await logTransition(w, cur.id, cur.state, next.state, e.action === 'close' ? `Closed for you · ${e.reason}` : e.action === 'ask_looks_done' ? `Likely done: ${e.reason}` : e.action === 'wait' ? `Waiting on them · ${e.reason}` : e.reason);
          return true;
        });
        if (r.result) {
          applied[e.action] = (applied[e.action] ?? 0) + 1;
          auditIds[e.itemId] = r.auditId;
        } else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (Object.keys(applied).length) for (const t of ['today', 'home', 'triage', 'items'] as const) this.ctx.bus.publish({ topic: t, ids: Object.keys(auditIds), reason: 'settle.apply' });
    return { applied, skipped, auditIds };
  }

  // =========================================================================
  // Engine seam (not a route): an engine write that respects user locks. Used by the parity tests;
  // ENGINES-core / the worker write the same way (engineUpdate → change_proposals for locked fields).
  // =========================================================================

  async engineUpdateItem(itemId: string, patch: Partial<WorkItemRecord>, reason: string): Promise<{ applied: string[]; proposalIds: string[]; auditId: string }> {
    let applied: string[] = [];
    let proposalIds: string[] = [];
    const r = await this.ctx.mutate({ action: 'item.engine_update', summary: reason, entity: { type: 'work_item', id: itemId }, actor: 'engine' }, async (w, model) => {
      const cur = this.ctx.item(model, itemId);
      await w.tx.update(changeSets).set({ summary: `${reason}: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
      const res = await this.ctx.writeItem(w, model, cur, { ...cur, ...patch } as WorkItemRecord, { bump: true });
      const groups = new Set<string>();
      for (const p of res.proposals) {
        const [row] = await w.tx.select({ g: changeProposals.groupId }).from(changeProposals).where(eq(changeProposals.id, p.proposalId));
        if (row) groups.add(row.g);
      }
      if (groups.size) await w.tx.update(changeProposals).set({ reason }).where(inArray(changeProposals.groupId, [...groups]));
      proposalIds = [...groups];
      const { WORK_FIELD_COLUMN } = await import('../store/work');
      applied = Object.keys(patch).filter((k) => !res.proposals.some((p) => p.field === (WORK_FIELD_COLUMN[k] ?? k)));
    });
    return { applied, proposalIds, auditId: r.auditId };
  }

  /**
   * Engine seam: one closure signal (scanner evidence, session state, Drive digest, reply, timer,
   * loop-back) decided by ENGINES-core `applySignal()` and written as one engine change set with the same
   * writers user verbs use: a transition row, the fields, proposals when the user locked the status (or a
   * field the target state needs), a sibling item, and the reopen_decisions row. Undo is undoChangeSet.
   */
  async applyClosureSignal(itemId: string, signal: Signal, settings: ClosureSettings = DEFAULT_CLOSURE_SETTINGS): Promise<{ decision: ClosureDecision; auditId: string | null; proposalId: string | null; siblingId: string | null }> {
    const m0 = await this.ctx.model(WHOLE);
    const decision = applySignal(closureItemOf(this.ctx.item(m0, itemId), m0.ctx.me), signal, settings);
    if (decision.kind === 'none') return { decision, auditId: null, proposalId: null, siblingId: null };
    let proposalId: string | null = null;
    let siblingId: string | null = null;
    const r = await this.ctx.mutate({ action: `closure.${signal.type}`, summary: decision.reason, entity: { type: 'work_item', id: itemId }, actor: 'engine' }, async (w, model) => {
      const cur = this.ctx.item(model, itemId);
      const d = applySignal(closureItemOf(cur, model.ctx.me), signal, settings); // decided again inside the transaction
      await w.tx.update(changeSets).set({ summary: `${d.reason}: ${cur.title}` }).where(eq(changeSets.id, w.cs.id));
      const at = w.now.toISOString();
      const evidenceId = d.transition?.evidenceId ?? signal.evidenceId ?? null;
      const evidence = evidenceId && model.all('evidence').some((e) => e.id === evidenceId) ? evidenceId : null;
      if (d.kind === 'proposal') {
        // the machine proposes what it would have written: rebuild that decision, stage the whole record
        const st = d.proposals.find((p) => p.field === 'status');
        const wanted: ClosureDecision = {
          ...d,
          transition: st ? { from: st.currentValue as never, to: st.proposedValue as never, actor: 'engine', reason: d.reason, evidenceId: evidence, autonomy: null } : null,
          fieldChanges: d.proposals.filter((p) => p.field !== 'status').map((p) => ({ field: p.field as never, before: p.currentValue, after: p.proposedValue })),
        };
        proposalId = await this.ctx.ds.chats.stageRecord(w, model, cur, recordAfterDecision(cur, wanted, at), d.reason, 'engine', st ? { state: 'State' } : {});
        return;
      }
      if (d.kind === 'sibling' && d.sibling) {
        const sib: WorkItemRecord = {
          ...blankItem(at, model.ctx.me),
          id: crypto.randomUUID(),
          kind: d.sibling.kind,
          title: d.sibling.title,
          initiativeId: d.sibling.initiativeId,
          accountId: cur.accountId,
          oppId: cur.oppId,
          why: d.sibling.label.text,
          involvement: d.sibling.involvement,
          sources: cur.sources.slice(0, 1),
        };
        siblingId = sib.id;
        await insertWorkItem(w, sib, this.ctx.links(model), { locks: [] });
        await logTransition(w, sib.id, null, 'open', d.sibling.label.text, evidence);
      } else {
        const next = recordAfterDecision(cur, d, at);
        await this.ctx.writeItem(w, model, cur, next, { bump: true });
      }
      const transitionId = d.transition ? await logTransition(w, cur.id, cur.state, stateFromEngine(d.transition.to), d.transition.reason, evidence) : null;
      if (d.reopenDecision) {
        await w.tx.insert(reopenDecisions).values({
          ownerUserId: w.userId,
          doneWorkItemId: cur.id,
          triggerEvidenceId: evidence,
          outcome: d.reopenDecision.outcome,
          ruleKey: d.reopenDecision.ruleKey,
          explanation: d.reopenDecision.explanation,
          newWorkItemId: siblingId,
          initiativeId: cur.initiativeId,
          transitionId,
          decidedBy: 'engine',
          changeSetId: w.cs.id,
        });
      }
    });
    return { decision, auditId: r.undoable ? r.auditId : null, proposalId, siblingId };
  }

  /** Engine revision of a draft body (user-touched → a doc proposal). */
  async engineReviseDraft(draftId: string, newText: string, reason: string): Promise<{ proposalIds: string[] }> {
    let ids: string[] = [];
    await this.ctx.mutate({ action: 'nba.revise', summary: `NBA updated: ${reason}`, entity: { type: 'draft', id: draftId }, actor: 'engine' }, async (w, model) => {
      const d = this.ctx.ds.drafts.draft(model, draftId);
      const doc = docFromText(newText);
      if (d.userTouched) ids = (await engineDraftDoc(w, d, doc, reason)).proposalIds;
      else await updateDraft(w, d, { ...d, doc, plainText: plainText(doc), rendered: renderAll(d.destination, doc) }, { bump: true });
    });
    return { proposalIds: ids };
  }

  /** Read-only helper for tests: the change set behind an audit id. */
  async changeSet(csId: string) {
    const [row] = await this.ctx.db.select().from(changeSets).where(eq(changeSets.id, csId));
    return row ?? null;
  }

  async rawKv() {
    return loadKv(this.ctx.db, await this.ctx.userId());
  }
}
