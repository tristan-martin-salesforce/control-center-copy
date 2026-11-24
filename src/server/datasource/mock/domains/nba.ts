/**
 * The mock DataSource, nba domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import type { NbaCard, NbaPayload, PolicyWeights, Proposal, TipTapDoc, WorkItemRecord } from '@/contract';
import { AppError, invalid } from '@/server/errors';
import { docFromText, plainText, renderAll, textDiff } from '../render';
import { nowCardFor } from '../views';

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

export class MockNba {
  constructor(private readonly ctx: MockCtx) {}

  private nbaPayload(itemId: string): NbaPayload {
    const card = nowCardFor(this.ctx.store, this.ctx.item(itemId));
    return { nba: card.nba, draft: card.draft, proposals: card.proposals };
  }

  async getItemNba({ params }: I<'getItemNba'>): Promise<Res<'getItemNba'>> {
    return this.nbaPayload(params.id);
  }

  async regenerateNba({ params, body }: I<'regenerateNba'>): Promise<Res<'regenerateNba'>> {
    const nba = this.ctx.store.must('nbas', params.id, 'NBA');
    this.ctx.checkVersion(nba, body.ifVersion, 'NBA', nba);
    const draft = nba.draftId ? this.ctx.store.get('drafts', nba.draftId) : undefined;
    const reasons = { regenerate: 'Regenerated', shorter: 'Made shorter', more_formal: 'Made more formal', add_detail: 'Added detail' } as const;
    const reason = reasons[body.instruction];
    const { entry } = this.ctx.tx({ actor: 'user', action: `nba.${body.instruction}`, summary: `${reason}: ${nba.title}`, entity: { type: 'nba', id: nba.id, label: nba.title } }, (tx) => {
      let update: NbaCard['update'] = { at: this.ctx.nowIso(), reason, kind: 'revised', proposalId: null, diffSummary: null, source: null };
      if (draft) {
        const newText = rewrite(draft.plainText, body.instruction);
        const newDoc = docFromText(newText);
        if (draft.userTouched) {
          const pid = this.ctx.ds.engine.propose(tx, { type: 'draft', id: draft.id, label: 'Draft body' }, [{ field: 'doc', label: 'Draft body', before: draft.doc, after: newDoc }], reason, draft.version, 'engine', null, textDiff(draft.plainText, newText));
          update = { ...update, kind: 'proposal', proposalId: pid };
        } else {
          tx.put('drafts', this.ctx.bump({ ...draft, doc: newDoc, plainText: plainText(newDoc), rendered: renderAll(draft.destination, newDoc) }));
        }
      }
      const v = update.kind === 'revised' ? nba.version + 1 : nba.version;
      tx.put('nbas', { ...nba, version: v, update, generatedAt: this.ctx.nowIso(), versions: update.kind === 'revised' ? [...nba.versions, { version: v, at: this.ctx.nowIso(), reason, diffSummary: null }] : nba.versions });
    });
    return { entity: this.nbaPayload(nba.workItemId), auditId: entry?.id ?? null };
  }

  /** B4: the entity is still at the proposal's base version, or every field it changes still holds the value it was proposed over. */
  private proposalStillCurrent(p: Proposal): boolean {
    const cur = p.entity.type === 'work_item' ? this.ctx.store.get('workItems', p.entity.id) : p.entity.type === 'draft' ? this.ctx.store.get('drafts', p.entity.id) : undefined;
    if (!cur) return true;
    if ((cur as { version?: number }).version === p.baseVersion) return true;
    const rec = cur as unknown as Record<string, unknown>;
    return p.changes.every((c) => JSON.stringify(rec[c.field] ?? null) === JSON.stringify(c.before ?? null));
  }

  async applyProposal({ params }: I<'applyProposal'>): Promise<Res<'applyProposal'>> {
    const chat = await this.ctx.ds.be6.apply(params.id, this.ctx.ds); // BE-CHAT: a chat plan → one change set, actor chat (+ D-58 route calls)
    if (chat) return chat;
    const p = this.ctx.store.must('proposals', params.id, 'Proposal');
    if (p.status !== 'pending') throw invalid(`Proposal is ${p.status}`);
    if (p.entity.type === 'policy') {
      const pol = this.ctx.store.settings().policy;
      const weights = { ...pol.weights } as PolicyWeights;
      for (const c of p.changes) if (c.field.startsWith('weights.')) weights[c.field.slice(8) as keyof PolicyWeights] = Number(c.after);
      const res = this.ctx.ds.settingsDomain.applyPolicyInternal(weights, pol.rules, `Applied from chat: ${p.reason}`, 'chat', (tx) => tx.put('proposals', { ...p, status: 'applied', resolvedAt: this.ctx.nowIso() }));
      return { entity: this.ctx.store.get('proposals', p.id)!, auditId: res.entry?.id ?? null, receipt: res.receipt };
    }
    // 2026-11-13 audit B4 (the db's proposalStillCurrent): an old proposal never overwrites newer data
    if (p.baseVersion !== null && !this.proposalStillCurrent(p)) throw new AppError('conflict', 'Changed since this was proposed: nothing was applied. Review it: keep what is there now (Not now), or wait for the next update to propose again', { current: p, reason: 'changed_since' });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'proposal.apply', summary: `Applied: ${p.reason}`, entity: p.entity }, (tx) => {
      if (p.entity.type === 'work_item') {
        const cur = this.ctx.item(p.entity.id);
        const patch: Record<string, unknown> = {};
        for (const c of p.changes) patch[c.field] = c.after;
        tx.put('workItems', this.ctx.bump({ ...cur, ...patch } as WorkItemRecord));
      } else if (p.entity.type === 'draft') {
        const d = this.ctx.store.must('drafts', p.entity.id, 'Draft');
        const docChange = p.changes.find((c) => c.field === 'doc');
        const doc = (docChange?.after as TipTapDoc | undefined) ?? d.doc;
        tx.put('drafts', this.ctx.bump({ ...d, doc, plainText: plainText(doc), rendered: renderAll(d.destination, doc), userTouched: true }));
        const nba = d.nbaId ? this.ctx.store.get('nbas', d.nbaId) : undefined;
        if (nba && nba.update?.proposalId === p.id) {
          tx.put('nbas', { ...nba, version: nba.version + 1, update: { ...nba.update, kind: 'revised', reason: `Applied: ${nba.update.reason}` }, versions: [...nba.versions, { version: nba.version + 1, at: this.ctx.nowIso(), reason: `Applied: ${p.reason}`, diffSummary: null }] });
        }
      } else {
        throw invalid(`Proposals on ${p.entity.type} are not supported in mock mode`);
      }
      tx.put('proposals', { ...p, status: 'applied', resolvedAt: this.ctx.nowIso() });
    });
    return { entity: this.ctx.store.get('proposals', p.id)!, auditId: entry?.id ?? null };
  }

  async rejectProposal({ params }: I<'rejectProposal'>): Promise<Res<'rejectProposal'>> {
    const chat = this.ctx.ds.be6.reject(params.id); // BE-CHAT: Dismiss a chat plan
    if (chat) return chat;
    const p = this.ctx.store.must('proposals', params.id, 'Proposal');
    if (p.status !== 'pending') throw invalid(`Proposal is ${p.status}`);
    const { entry } = this.ctx.tx({ actor: 'user', action: 'proposal.reject', summary: `Kept mine: ${p.reason}`, entity: p.entity }, (tx) => {
      tx.put('proposals', { ...p, status: 'rejected', resolvedAt: this.ctx.nowIso() });
      for (const nba of this.ctx.store.all('nbas')) if (nba.update?.proposalId === p.id) tx.put('nbas', { ...nba, update: null });
    });
    return { entity: this.ctx.store.get('proposals', p.id)!, auditId: entry?.id ?? null };
  }
}
