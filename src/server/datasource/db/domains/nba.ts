/**
 * The db DataSource, nba domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Draft, NbaCard, NbaPayload, Proposal } from '@/contract';
import { applyProposal as applyProposalRow, engineUpdate, proposalStillCurrent, rejectProposal as rejectProposalRow } from '@/db/changeset';
import type { Tx } from '@/db/client';
import { changeProposals, changeSets, drafts as draftsTable, workItems } from '@/db/schema';
import { AppError, invalid, notFound } from '@/server/errors';
import { docFromText, plainText, renderAll } from '../../mock/render';
import type { ReadModel } from '../model';
import { updateDraft, updateNba } from '../store/nba';
import { withdrawDraftsOfClosedItems } from '../store/withdraw';
import { nowCardFor } from '../views';

/** B4: the refusal when a proposal's field changed after it was proposed. */
export const PROPOSAL_CHANGED_SINCE = 'Changed since this was proposed: nothing was applied. Review it: keep what is there now (Not now), or wait for the next update to propose again';

// ---------------------------------------------------------------------------
// helpers (presentation rules shared with the mock)
// ---------------------------------------------------------------------------

/**
 * Apply a multi-field proposal group in ONE update. A closure proposal ("Likely done · Confirm?") stages
 * status + done_at + done_by together, and work_items_done_chk rejects any of them alone; BE-0's
 * applyProposal applies one field per statement, so a group goes through here (same SQL, same
 * bookkeeping: version + 1, accepted, decided_by / applied_change_set_id from the change set).
 */
async function applyProposalGroup(tx: Tx, ids: string[]): Promise<void> {
  const props = await tx.select().from(changeProposals).where(inArray(changeProposals.id, ids)).for('update');
  if (!props.length) return;
  const { entityType, entityId } = props[0]!;
  if (props.some((p) => p.entityType !== entityType || p.entityId !== entityId || p.status !== 'pending')) throw invalid('Proposal group spans several rows or is no longer pending');
  const cols = (await tx.execute<{ name: string }>(sql`select attname as name from pg_attribute where attrelid = to_regclass(${`public.${entityType}`}) and attnum > 0 and not attisdropped`)).rows.map((r) => r.name);
  const fields = props.map((p) => p.field);
  for (const f of fields) if (!cols.includes(f) || ['id', 'version', 'owner_user_id', 'created_at', 'updated_at'].includes(f)) throw invalid(`Proposal field ${f} cannot be applied`);
  const image = JSON.stringify(Object.fromEntries(props.map((p) => [p.field, p.proposedValue ?? null])));
  const t = sql.identifier(entityType);
  const sets = fields.map((f) => sql`${sql.identifier(f)} = (jsonb_populate_record(null::${t}, ${image}::jsonb)).${sql.identifier(f)}`);
  if (cols.includes('version')) sets.push(sql`version = version + 1`);
  if (cols.includes('updated_at')) sets.push(sql`updated_at = now()`);
  const res = await tx.execute(sql`update ${t} set ${sql.join(sets, sql`, `)} where id = ${entityId} returning 1`);
  if (!res.rows.length) throw notFound(entityType, entityId);
  await tx
    .update(changeProposals)
    .set({
      status: 'accepted',
      decidedAt: new Date(),
      decidedBy: sql`nullif(current_setting('cc.actor_kind', true), '')::actor_kind`,
      appliedChangeSetId: sql`nullif(current_setting('cc.change_set_id', true), '')::uuid`,
    })
    .where(inArray(changeProposals.id, ids));
}

function rewrite(text: string, instruction: 'regenerate' | 'shorter' | 'more_formal' | 'add_detail'): string {
  switch (instruction) {
    case 'shorter': {
      const sentences = text.split(/(?<=[.!?])\s+/);
      return sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join(' ');
    }
    case 'more_formal':
      return `${text.replace(/^Hi\b/, 'Hello').replace(/\bthanks\b/gi, 'thank you')}\n\nKind regards`;
    case 'add_detail':
      return `${text}\n\nFor context: this follows our last call and the notes in the shared doc.`;
    case 'regenerate':
      return text.replace(/^(Hi|Hello) (\w+),?/, (_m, _g, name) => `Hey ${name},`);
  }
}

export class DbNba {
  constructor(private readonly ctx: DbCtx) {}

  private nbaPayload(m: ReadModel, itemId: string): NbaPayload {
    const card = nowCardFor(m, this.ctx.item(m, itemId));
    return { nba: card.nba, draft: card.draft, proposals: card.proposals };
  }

  async getItemNba({ params }: I<'getItemNba'>): Promise<Res<'getItemNba'>> {
    return this.nbaPayload(await this.ctx.model(WHOLE), params.id);
  }

  private isSession(m: ReadModel) {
    return (runId: string) => m.get('agentRuns', runId)?.kind === 'claude_session';
  }

  async regenerateNba({ params, body }: I<'regenerateNba'>): Promise<Res<'regenerateNba'>> {
    let itemId = '';
    const r = await this.ctx.mutate({ action: `nba.${body.instruction}`, summary: 'Regenerated', entity: { type: 'nba', id: params.id }, current: async () => (await this.ctx.model(WHOLE)).get('nbas', params.id) ?? null }, async (w, model) => {
      const nba = model.get('nbas', params.id);
      if (!nba) throw notFound('NBA', params.id);
      itemId = nba.workItemId;
      this.ctx.checkVersion(nba, body.ifVersion, 'NBA', nba);
      const draft = nba.draftId ? model.get('drafts', nba.draftId) : undefined;
      const reasons = { regenerate: 'Regenerated', shorter: 'Made shorter', more_formal: 'Made more formal', add_detail: 'Added detail' } as const;
      const reason = reasons[body.instruction];
      await w.tx.update(changeSets).set({ summary: `${reason}: ${nba.title}` }).where(eq(changeSets.id, w.cs.id));
      let update: NbaCard['update'] = { at: w.now.toISOString(), reason, kind: 'revised', proposalId: null, diffSummary: null, source: null };
      if (draft) {
        const newDoc = docFromText(rewrite(draft.plainText, body.instruction));
        if (draft.userTouched) {
          // an engine rewrite of a touched draft is a proposal ("Apply / Keep mine"), whatever the request actor
          const res = await engineUpdate(w.tx, draftsTable, draft.id, { docJson: newDoc as unknown as Record<string, unknown> }, { lockAll: true, reason });
          const pid = res.proposals[0]?.proposalId ?? null;
          const groupId = pid ? ((await w.tx.select({ g: changeProposals.groupId }).from(changeProposals).where(eq(changeProposals.id, pid)))[0]?.g ?? pid) : null;
          update = { ...update, kind: 'proposal', proposalId: groupId };
        } else {
          await updateDraft(w, draft, { ...draft, doc: newDoc, plainText: plainText(newDoc), rendered: renderAll(draft.destination, newDoc) }, { bump: true });
        }
      }
      const v = update.kind === 'revised' ? nba.version + 1 : nba.version;
      await updateNba(w, nba, { ...nba, version: v, update, generatedAt: w.now.toISOString(), versions: update.kind === 'revised' ? [...nba.versions, { version: v, at: w.now.toISOString(), reason, diffSummary: null }] : nba.versions }, this.isSession(model));
    });
    return { entity: this.nbaPayload(await this.ctx.model(WHOLE), itemId), auditId: r.auditId };
  }

  async proposal(m: ReadModel, pid: string): Promise<Proposal> {
    const p = m.get('proposals', pid);
    if (!p) throw notFound('Proposal', pid);
    return p;
  }

  async applyProposal({ params }: I<'applyProposal'>): Promise<Res<'applyProposal'>> {
    const chat = await this.ctx.ds.be6.apply(params.id, this.ctx.ds); // BE-CHAT: a chat plan → one change set, actor chat (+ D-58 route calls)
    if (chat) return chat;
    const r = await this.ctx.mutate({ action: 'proposal.apply', summary: 'Applied proposal', entity: { type: 'proposal', id: params.id } }, async (w, model) => {
      const p = await this.proposal(model, params.id);
      if (p.status !== 'pending') throw invalid(`Proposal is ${p.status}`);
      if (p.entity.type === 'policy') throw invalid('Policy proposals come from chat, which is not wired yet (BE-6)');
      await w.tx.update(changeSets).set({ summary: `Applied: ${p.reason}`, entityType: p.entity.type, entityId: p.entity.id }).where(eq(changeSets.id, w.cs.id));
      const rows = await w.tx.select({ id: changeProposals.id }).from(changeProposals).where(and(eq(changeProposals.groupId, params.id), eq(changeProposals.status, 'pending')));
      // 2026-11-13 audit B4: an old proposal never overwrites newer data: the field must still be what it was proposed over
      for (const row of rows) if (!(await proposalStillCurrent(w.tx, row.id))) throw new AppError('conflict', PROPOSAL_CHANGED_SINCE, { current: p, reason: 'changed_since' });
      if (rows.length === 1) await applyProposalRow(w.tx, rows[0]!.id);
      else await applyProposalGroup(w.tx, rows.map((r) => r.id));
      if (p.entity.type === 'draft') {
        const d = model.get('drafts', p.entity.id);
        if (!d) throw notFound('Draft', p.entity.id);
        const doc = (p.changes.find((c) => c.field === 'doc')?.after as Draft['doc'] | undefined) ?? d.doc;
        // the helper wrote doc_json (and bumped the version); the derived columns follow
        await w.tx.update(draftsTable).set({ plainText: plainText(doc), editedByUser: true, docVersion: sql`${draftsTable.docVersion} + 1` }).where(eq(draftsTable.id, d.id));
        const after: Draft = { ...d, doc, plainText: plainText(doc), rendered: renderAll(d.destination, doc), userTouched: true };
        await updateDraft(w, { ...after, rendered: {} }, after, { bump: false });
        const nba = d.nbaId ? model.get('nbas', d.nbaId) : undefined;
        if (nba && nba.update?.proposalId === p.id) {
          await updateNba(w, nba, { ...nba, version: nba.version + 1, update: { ...nba.update, kind: 'revised', reason: `Applied: ${nba.update.reason}` }, versions: [...nba.versions, { version: nba.version + 1, at: w.now.toISOString(), reason: `Applied: ${p.reason}`, diffSummary: null }] }, this.isSession(model));
        }
      } else if (p.entity.type === 'work_item') {
        await w.tx.update(workItems).set({ updatedAt: w.now }).where(eq(workItems.id, p.entity.id));
        // OUTBOX-W: an applied status proposal that closes the item withdraws its pending drafts (no-op otherwise)
        this.ctx.putWithdrawn(model, await withdrawDraftsOfClosedItems(w.tx, w.userId, { itemIds: [p.entity.id], at: w.now }), w.now);
      }
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: await this.proposal(m, params.id), auditId: r.auditId };
  }

  async rejectProposal({ params }: I<'rejectProposal'>): Promise<Res<'rejectProposal'>> {
    const chat = await this.ctx.ds.be6.reject(params.id); // BE-CHAT: Dismiss a chat plan
    if (chat) return chat;
    const r = await this.ctx.mutate({ action: 'proposal.reject', summary: 'Kept mine', entity: { type: 'proposal', id: params.id } }, async (w, model) => {
      const p = await this.proposal(model, params.id);
      if (p.status !== 'pending') throw invalid(`Proposal is ${p.status}`);
      await w.tx.update(changeSets).set({ summary: `Kept mine: ${p.reason}`, entityType: p.entity.type, entityId: p.entity.id }).where(eq(changeSets.id, w.cs.id));
      const rows = await w.tx.select({ id: changeProposals.id }).from(changeProposals).where(and(eq(changeProposals.groupId, params.id), eq(changeProposals.status, 'pending')));
      for (const row of rows) await rejectProposalRow(w.tx, row.id);
      for (const nba of model.all('nbas')) if (nba.update?.proposalId === p.id) await updateNba(w, nba, { ...nba, update: null }, this.isSession(model));
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: await this.proposal(m, params.id), auditId: r.auditId };
  }
}
