/**
 * The mock DataSource, drafts domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import type { DispatchMode, Draft } from '@/contract';
import { AppError, invalid } from '@/server/errors';
import { planUseCases } from '@/engines/activity/use-cases';
import { myDcRowsOf } from '@/server/deals/dc-requests';
import { MockOutbox } from '../outbox';
import { preflightUseCases } from '@/server/time/canvas-preflight';
import { payloadFor, plainText, previewHtml, renderAll, renditionFor } from '../render';
import { buildOutbox, isLive } from '../views';
import { baseCandidates, buildDraftSource, slackLabels } from '../../draft-source';

export class MockDrafts {
  constructor(private readonly ctx: MockCtx) {}

  async getDraft({ params }: I<'getDraft'>): Promise<Res<'getDraft'>> {
    return this.ctx.store.must('drafts', params.id, 'Draft');
  }

  /** The message a draft replies to: its thread context and its work item's evidence (the mock has no source items). */
  async getDraftSource({ params }: I<'getDraftSource'>): Promise<Res<'getDraftSource'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    const wi = d.workItemId ? this.ctx.store.get('workItems', d.workItemId) : undefined;
    const evidence = wi ? this.ctx.store.all('evidence').filter((e) => e.workItemId === wi.id) : [];
    return buildDraftSource({ draft: d, candidates: baseCandidates(d, evidence, this.ctx.store.meta().user), itemSources: wi?.sources ?? [], labels: slackLabels(this.ctx.store.all('people')) });
  }

  async patchDraft({ params, body }: I<'patchDraft'>): Promise<Res<'patchDraft'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
    if (['sending', 'sent', 'verified', 'staged'].includes(d.status)) throw invalid(`Draft is ${d.status}; it can no longer be edited`);
    // A structured action is read-only once drafted: its body is the exact request the user approves.
    if ((d.destination.kind === 'action' || body.destination?.kind === 'action') && (body.doc || body.destination || (body.mode && body.mode !== d.mode))) {
      throw invalid('Action items are read-only: reject this one and draft the change again');
    }
    const doc = body.doc ?? d.doc;
    const destination = body.destination ?? d.destination;
    const locks = new Set(d.userLockedFields);
    if (body.doc) locks.add('doc');
    if (body.destination) locks.add('destination');
    if (body.mode) locks.add('mode');
    const scheduledFor = body.scheduledFor === undefined ? d.scheduledFor : body.scheduledFor;
    const next: Draft = this.ctx.bump({
      ...d,
      doc,
      destination,
      mode: body.mode ?? d.mode,
      plainText: plainText(doc),
      rendered: renderAll(destination, doc),
      userTouched: true,
      userLockedFields: [...locks],
      scheduledFor,
      status: scheduledFor ? 'scheduled' : d.status === 'scheduled' ? 'ready' : d.status === 'failed' ? 'drafting' : d.status,
      savedAt: this.ctx.nowIso(),
    });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'draft.autosave', summary: 'Draft edited', entity: { type: 'draft', id: d.id, label: 'Draft' }, coalesceKey: `draft:${d.id}` }, (tx) => tx.put('drafts', next));
    return { entity: next, auditId: entry?.id ?? null };
  }

  confirmTokenFor(d: Draft, mode: DispatchMode): string {
    const payload = JSON.stringify(payloadFor(d.destination, d.doc, mode));
    let h = 0;
    for (let i = 0; i < payload.length; i++) h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
    return `ct_${d.id}_${d.version}_${mode}_${(h >>> 0).toString(36)}`;
  }

  /** Add to Outbox (BE-CHAT): drafting → ready (pending approval). Idempotent on ready; any other status is a 409. */
  async queueDraft({ params, body }: I<'queueDraft'>): Promise<Res<'queueDraft'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    if (d.status === 'ready') return { entity: d, auditId: null };
    if (d.status !== 'drafting') throw new AppError('conflict', `Draft is ${d.status}; only a drafting draft can be added to the Outbox`, { current: d });
    this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
    const next: Draft = this.ctx.bump({ ...d, status: 'ready', savedAt: this.ctx.nowIso() });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'draft.queue', summary: 'Added to the Outbox', entity: { type: 'draft', id: d.id, label: 'Draft' } }, (tx) => tx.put('drafts', next));
    return { entity: next, auditId: entry?.id ?? null };
  }

  /** REJECT-1: the user turns a draft down. It leaves the Outbox; nothing is sent; the work item stays open. Undoable. */
  async rejectDraft({ params, body }: I<'rejectDraft'>): Promise<Res<'rejectDraft'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    if (d.status === 'rejected') return { entity: d, auditId: null };
    if (!['drafting', 'ready', 'scheduled', 'failed'].includes(d.status)) throw new AppError('conflict', `Draft is ${d.status}; only a draft that hasn't been sent can be rejected`, { current: d });
    if (body.ifVersion !== undefined) this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
    const next: Draft = this.ctx.bump({ ...d, status: 'rejected', rejectedReason: body.reason ?? null, savedAt: this.ctx.nowIso() });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'draft.reject', summary: 'Rejected the draft (nothing sent)', entity: { type: 'draft', id: d.id, label: 'Draft' } }, (tx) => tx.put('drafts', next));
    // D-70: a rejected canvas's writes are rejected (its rows go back to waiting)
    this.ctx.ds.canvas.landings();
    return { entity: next, auditId: entry?.id ?? null };
  }

  async previewDraft({ params, body }: I<'previewDraft'>): Promise<Res<'previewDraft'>> {
    const d = this.ctx.store.must('drafts', params.id, 'Draft');
    const mode = body.mode ?? this.ctx.ds.outbox.defaultMode(d);
    // One serializer (src/lib/compose): the payload here is byte-identical to what dispatch posts.
    return {
      draftId: d.id,
      version: d.version,
      destination: d.destination,
      mode,
      rendition: renditionFor(d.destination, d.doc),
      payload: payloadFor(d.destination, d.doc, mode),
      confirmToken: this.confirmTokenFor(d, mode),
      dryRun: this.ctx.store.settings().sending.dryRun,
      html: previewHtml(d.destination, d.doc, this.mentionLabels()),
    };
  }

  /** Slack user id → display name, so previews show "@Dana Reyes" for `<@U…>`. */
  private mentionLabels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.ctx.store.all('people')) if (p.slackHandle) out[p.slackHandle] = p.name;
    return out;
  }

  /** Never calls any external system: dry-run records the payload; live mode runs the adapters on a simulated transport. */
  async dispatchDraft(i: I<'dispatchDraft'>): Promise<Res<'dispatchDraft'>> {
    return this.ctx.ds.outbox.dispatch(i);
  }

  createOutbox(): MockOutbox {
    return new MockOutbox({
      store: () => this.ctx.store,
      now: () => this.ctx.now(),
      checkVersion: (cur, v, what, current) => this.ctx.checkVersion(cur, v, what, current),
      confirmTokenFor: (d, mode) => this.confirmTokenFor(d, mode),
      tx: (meta, fn) => this.ctx.tx(meta, fn),
      bump: (v) => this.ctx.bump(v),
      later: (ms, fn) => this.ctx.later(ms, fn),
      verifyMs: () => this.ctx.delays.verifyMs,
      newId: (prefix) => id(prefix),
      // D-65: the Apply preflight's DC (D-68) and use-case (D-67) state, the db's rule over the mock's store
      preflightExtra: () => ({
        dcLive: { requests: this.ctx.ds.deals.dcRequests(), myDcs: myDcRowsOf(this.ctx.store.all('opps'), (aid) => this.ctx.store.get('accounts', aid)?.name ?? null) },
        ...preflightUseCases(planUseCases(this.ctx.ds.deals.ucPlanInput()).items),
      }),
      onVerifiedSend: (d) => {
        if (!d.workItemId || !this.ctx.store.get('workItems', d.workItemId) || !isLive(this.ctx.item(d.workItemId))) return;
        const dest = d.destination.kind === 'slack' ? 'Slack' : 'Gmail';
        this.ctx.ds.engine.engineCloseItem(d.workItemId, `Reply verified in ${dest}`, { kind: d.destination.kind === 'slack' ? 'slack' : 'gmail', label: `${dest} · sent by you` });
      },
    });
  }

  async getOutbox(_i: I<'getOutbox'>): Promise<Res<'getOutbox'>> {
    return buildOutbox(this.ctx.store, this.ctx.store.meta().user);
  }

  /** D-90 (W12-7): a built release → its two pending Outbox items (src/outbox/release.ts); nothing is sent. */
  async stageRelease({ body }: I<'stageRelease'>): Promise<Res<'stageRelease'>> {
    return { entity: await this.ctx.ds.outbox.stageRelease(body), auditId: null };
  }
}
