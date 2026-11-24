/**
 * The db DataSource, drafts domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { EDITOR_SESSION, WHOLE, I, Res } from '../shared';
import { and, eq, sql } from 'drizzle-orm';
import type { ActionDestination, Draft } from '@/contract';
import { enqueueJob } from '@/db/queue';
import { contentRevisions } from '@/db/schema';
import { personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';
import { payloadFor, plainText, previewHtml, renderAll, renditionFor } from '../../mock/render';
import type { ReadModel } from '../model';
import { OUTBOX } from '../reads/scope';
import type { WriteCtx } from '../store/common';
import { insertDraft, updateDraft } from '../store/nba';
import { actionDraftFor } from '@/server/vdp/coverage';
import { feedbackHeld } from '@/lib/feedback/payload';
import { actionDoc, actionSummary } from '@/lib/actions';
import { dispatchAttempt, planDispatch, recordDispatch } from '../outbox';
import { checkHandoffConfirm, recordReleaseLanding, releaseDistributionFor } from '../outbox-release';
import { handedOff, isReleaseHandoff, stageRelease as stageReleaseItems, defaultModeFor, OUTBOX_QUEUE } from '@/outbox';
import { loggingProfile } from '@/engines/activity/persona';
import { dbPreflightContextFor } from '../store/canvas-preflight';
import { isPendingLogCanvas, preflightDraft } from '@/server/time/canvas-preflight';
import { preflightSummary } from '@/lib/canvas/preflight';
import { buildOutbox } from '../views';
import { baseCandidates, buildDraftSource, slackLabels } from '../../draft-source';
import { loadDraftSourceRows, rowLabels, withSourceRows } from '../store/draft-source';

/** LD-1: the live states a likely-done item can step back to on Not done. */
/** REJECT-1: a draft can be rejected until it starts sending (failed ones too: the user gives up on it). */
const REJECTABLE_DRAFT = new Set<Draft['status']>(['drafting', 'ready', 'scheduled', 'failed']);

/** Slack user id → display name, so previews show "@Dana Reyes" for `<@U…>` (same as the mock). */
function mentionLabels(m: ReadModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of m.all('people')) if (p.slackHandle) out[p.slackHandle] = p.name;
  return out;
}

export class DbDrafts {
  constructor(private readonly ctx: DbCtx) {}

  draft(m: ReadModel, did: string): Draft {
    const d = m.get('drafts', did);
    if (!d) throw notFound('Draft', did);
    return d;
  }

  async getDraft({ params }: I<'getDraft'>): Promise<Res<'getDraft'>> {
    return this.draft(await this.ctx.model(WHOLE), params.id);
  }

  /** The message a draft replies to: the model's thread context and evidence, told what the thread's source items know. */
  async getDraftSource({ params }: I<'getDraftSource'>): Promise<Res<'getDraftSource'>> {
    const m = await this.ctx.model(WHOLE);
    const d = this.draft(m, params.id);
    const wi = d.workItemId ? m.get('workItems', d.workItemId) : undefined;
    const evidence = wi ? m.all('evidence').filter((e) => e.workItemId === wi.id) : [];
    const rows = await loadDraftSourceRows(this.ctx.db, m.ctx.userId, d);
    return buildDraftSource({
      draft: d,
      candidates: withSourceRows(baseCandidates(d, evidence, m.ctx.me), rows, m.ctx.me),
      itemSources: wi?.sources ?? [],
      labels: { ...rowLabels(rows), ...slackLabels(m.all('people')) },
    });
  }

  async patchDraft({ params, body }: I<'patchDraft'>): Promise<Res<'patchDraft'>> {
    const r = await this.ctx.mutate(
      { action: 'draft.autosave', summary: 'Draft edited', entity: { type: 'draft', id: params.id }, burst: true, current: async () => this.draft(await this.ctx.model(WHOLE), params.id) },
      async (w, model) => {
        const d = this.draft(model, params.id);
        this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
        if (['sending', 'sent', 'verified', 'staged'].includes(d.status)) throw invalid(`Draft is ${d.status}; it can no longer be edited`);
        // A structured action is read-only once drafted: its body is the exact request the user approves.
        if ((d.destination.kind === 'action' || body.destination?.kind === 'action') && (body.doc || body.destination || (body.mode && body.mode !== d.mode))) {
          throw invalid('Action items are read-only: reject this one and draft the change again');
        }
        const doc = body.doc ?? d.doc;
        const destination = body.destination ?? d.destination;
        const locks = new Set(d.userLockedFields);
        const newly: Draft['userLockedFields'] = [];
        if (body.doc) newly.push('doc');
        if (body.destination) newly.push('destination');
        if (body.mode) newly.push('mode');
        for (const l of newly) locks.add(l);
        const scheduledFor = body.scheduledFor === undefined ? d.scheduledFor : body.scheduledFor;
        const next: Draft = {
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
          savedAt: w.now.toISOString(),
        };
        if (body.doc) await this.saveRevision(w, d, doc);
        await updateDraft(w, d, next, { bump: true, ifVersion: body.ifVersion, lock: newly });
      },
    );
    return { entity: this.draft(await this.ctx.model(WHOLE), params.id), auditId: r.auditId };
  }

  /**
   * W5: autosave revisions. Bodies stay out of the audit images (drafts.doc_json is omitted), so each
   * editor burst keeps its latest doc in content_revisions; the first edit also records the baseline.
   * Undo restores the revision before the burst (undoAudit).
   */
  private async saveRevision(w: WriteCtx, d: Draft, doc: Draft['doc']) {
    const existing = await w.tx.select({ id: contentRevisions.id }).from(contentRevisions).where(and(eq(contentRevisions.entityType, 'drafts'), eq(contentRevisions.entityId, d.id), eq(contentRevisions.field, 'doc_json'))).limit(1);
    if (!existing.length) {
      await w.tx.insert(contentRevisions).values({ ownerUserId: w.userId, entityType: 'drafts', entityId: d.id, field: 'doc_json', revision: 1, docJson: d.doc as unknown as Record<string, unknown>, contentHash: JSON.stringify(d.doc).length.toString(36), actorKind: 'engine', editorSessionId: 'baseline', closedAt: w.now });
    }
    await w.tx.execute(sql`
      INSERT INTO content_revisions AS r
         (owner_user_id, entity_type, entity_id, field, revision, doc_json, content_hash, actor_kind, editor_session_id, change_set_id)
      SELECT ${w.userId}, 'drafts', ${d.id}, 'doc_json', coalesce(max(revision), 0) + 1, ${JSON.stringify(doc)}::jsonb, ${JSON.stringify(doc).length.toString(36)}, 'user', ${EDITOR_SESSION}, ${w.cs.id}
        FROM content_revisions
       WHERE entity_type = 'drafts' AND entity_id = ${d.id} AND field = 'doc_json'
      ON CONFLICT (entity_type, entity_id, field, editor_session_id) WHERE closed_at IS NULL
      DO UPDATE SET doc_json = EXCLUDED.doc_json, content_hash = EXCLUDED.content_hash, last_saved_at = now(), save_count = r.save_count + 1, change_set_id = EXCLUDED.change_set_id`);
  }

  /** Bound to version + mode + the exact payload dispatch would make (one serializer: src/lib/compose). */
  confirmTokenFor(d: Draft, mode: 'draft' | 'send'): string {
    const payload = JSON.stringify(payloadFor(d.destination, d.doc, mode));
    let h = 0;
    for (let i = 0; i < payload.length; i++) h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
    return `ct_${d.id}_${d.version}_${mode}_${(h >>> 0).toString(36)}`;
  }

  /** Add to Outbox (BE-CHAT): drafting → ready (pending approval). Idempotent on ready; any other status is a 409. */
  async queueDraft({ params, body }: I<'queueDraft'>): Promise<Res<'queueDraft'>> {
    const cur = this.draft(await this.ctx.model(WHOLE), params.id);
    if (cur.status === 'ready') return { entity: cur, auditId: null };
    const r = await this.ctx.mutate({ action: 'draft.queue', summary: 'Added to the Outbox', entity: { type: 'draft', id: params.id }, current: async () => this.draft(await this.ctx.model(WHOLE), params.id) }, async (w, model) => {
      const d = this.draft(model, params.id);
      if (d.status !== 'drafting') throw new AppError('conflict', `Draft is ${d.status}; only a drafting draft can be added to the Outbox`, { current: d });
      this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
      await updateDraft(w, d, { ...d, status: 'ready', savedAt: w.now.toISOString() }, { bump: true, ifVersion: body.ifVersion });
    });
    this.ctx.bus.publishTables(['drafts'], [params.id], 'draft.queue');
    return { entity: this.draft(await this.ctx.model(WHOLE), params.id), auditId: r.undoable ? r.auditId : null };
  }

  /** REJECT-1: the user turns a draft down. It leaves the Outbox; nothing is sent; the work item stays open. Undoable. */
  async rejectDraft({ params, body }: I<'rejectDraft'>): Promise<Res<'rejectDraft'>> {
    const cur = this.draft(await this.ctx.model(WHOLE), params.id);
    if (cur.status === 'rejected') return { entity: cur, auditId: null };
    const r = await this.ctx.mutate({ action: 'draft.reject', summary: 'Rejected the draft (nothing sent)', entity: { type: 'draft', id: params.id }, current: async () => this.draft(await this.ctx.model(WHOLE), params.id) }, async (w, model) => {
      const d = this.draft(model, params.id);
      if (!REJECTABLE_DRAFT.has(d.status)) throw new AppError('conflict', `Draft is ${d.status}; only a draft that hasn't been sent can be rejected`, { current: d });
      if (body.ifVersion !== undefined) this.ctx.checkVersion(d, body.ifVersion, 'Draft', d);
      await updateDraft(w, d, { ...d, status: 'rejected', rejectedReason: body.reason ?? null, savedAt: w.now.toISOString() }, { bump: true, ...(body.ifVersion !== undefined ? { ifVersion: body.ifVersion } : {}) });
    });
    this.ctx.bus.publishTables(['drafts'], [params.id], 'draft.reject');
    // D-70: a rejected canvas's writes are rejected (its rows go back to waiting)
    await this.ctx.ds.canvas.syncLandingsQuietly('draft.reject');
    return { entity: this.draft(await this.ctx.model(WHOLE), params.id), auditId: r.undoable ? r.auditId : null };
  }

  async previewDraft({ params, body }: I<'previewDraft'>): Promise<Res<'previewDraft'>> {
    const m = await this.ctx.model(WHOLE);
    const d = this.draft(m, params.id);
    const mode = body.mode ?? defaultModeFor(d, m.settings().sending);
    // One serializer (src/lib/compose, via the mock's render adapter): byte-identical to what dispatch posts.
    return {
      draftId: d.id,
      version: d.version,
      destination: d.destination,
      mode,
      rendition: renditionFor(d.destination, d.doc),
      payload: payloadFor(d.destination, d.doc, mode),
      confirmToken: this.confirmTokenFor(d, mode),
      dryRun: m.settings().sending.dryRun,
      html: previewHtml(d.destination, d.doc, mentionLabels(m)),
    };
  }

  /**
   * Never calls any external system. Dry-run (default): the delivery engine records the exact payload and
   * would-be tool call ("Dry-run delivered") and returns it. Live: the confirm proof is checked, the approval
   * is recorded (approved_content_hash, payload hash) and `outbox.dispatch` is enqueued for the adapters
   * (src/outbox/job.ts), which re-check the approval before anything leaves.
   */
  async dispatchDraft({ params, body }: I<'dispatchDraft'>): Promise<Res<'dispatchDraft'>> {
    const m0 = await this.ctx.model(WHOLE);
    const d0 = this.draft(m0, params.id);
    this.ctx.checkVersion(d0, body.ifVersion, 'Draft', d0);
    if (isReleaseHandoff(d0.destination)) return this.markReleaseHandedOff(d0, body); // D-90: a hand-off never delivers
    // D-65 (TL-06, TL-24): a logging canvas is re-checked before anything leaves: re-rendered or refused, never stale
    await this.preflightLogCanvas(m0, d0);
    // Global dry run, and Settings ▸ Feedback "Post live" off for a feedback report (D-56).
    const dryRun = m0.settings().sending.dryRun !== false || feedbackHeld(d0.destination, m0.settings().feedback);
    const where = d0.destination.kind === 'slack' ? d0.destination.channelName : d0.destination.kind === 'action' ? d0.destination.target.label : d0.destination.subject;
    const plan = await planDispatch(d0, { mode: body.mode, confirmToken: body.confirmToken, expectedToken: this.confirmTokenFor(d0, body.mode), dryRun, now: this.ctx.now() });
    const { payload, rendition } = plan;
    const r = await this.ctx.mutate(
      { action: dryRun ? 'draft.dispatch.dry_run' : `draft.dispatch.${body.mode}`, summary: `${dryRun ? 'Dry run' : body.mode === 'send' ? 'Queued to send' : 'Queued as draft'}: ${where}`, entity: { type: 'draft', id: params.id }, undoable: false, current: async () => this.draft(await this.ctx.model(WHOLE), params.id) },
      async (w, model) => {
        const d = this.draft(model, params.id);
        const attempt = dispatchAttempt(plan, w.now.toISOString());
        const next: Draft = {
          ...d,
          mode: body.mode,
          attempts: [...d.attempts, attempt],
          ...(dryRun ? {} : { status: 'sending' as const, verification: { state: 'pending' as const, at: null, detail: 'Waiting for the send adapter' } }),
        };
        const res = await updateDraft(w, d, next, { bump: true, ifVersion: body.ifVersion });
        const attemptId = res.attemptIds[res.attemptIds.length - 1]!;
        await recordDispatch(w, d.id, attemptId, plan);
        if (!dryRun) {
          // B3: one attempt only: a delivery is never re-run by the queue (a second run could send twice)
          const job = await enqueueJob(w.tx, { ownerUserId: w.userId, kind: 'outbox.dispatch', queue: OUTBOX_QUEUE, payload: { draftId: d.id, attemptId, mode: body.mode, version: d.version + 1, payloadHash: plan.rec.payloadHash }, idempotencyKey: `outbox.dispatch:${d.id}:${attemptId}`, maxAttempts: 1 });
          await w.tx.execute(sql`update draft_send_attempts set job_id = ${job.id} where id = ${Number(attemptId)}`);
        }
        return attemptId;
      },
    );
    if (!dryRun) this.ctx.bus.publishTables(['jobs'], [params.id], 'draft.dispatch');
    const d = this.draft(await this.ctx.model(WHOLE), params.id);
    const attempt = d.attempts.find((a) => a.id === r.result) ?? d.attempts[d.attempts.length - 1]!;
    return { draft: d, dryRun, payload, rendition, attempt, auditId: r.auditId };
  }

  /**
   * D-65: the Apply preflight of a logging canvas (src/server/time/canvas-preflight.ts). A row that must not go (logged
   * by hand, declined, cancelled, dismissed, edited, no longer approved) is dropped: the item is re-rendered and Apply
   * refused so you review what goes; an item with nothing left is discarded and refused. Nothing is sent either way.
   */
  private async preflightLogCanvas(m: ReadModel, d: Draft): Promise<void> {
    if (!isPendingLogCanvas(d)) return;
    const ctx = await dbPreflightContextFor(this.ctx.db, m.ctx.userId, d, { taskTypeRequired: loggingProfile(personaOf(m.settings())).taskTypeRequired, useCases: true });
    const out = preflightDraft(d, ctx);
    if (!out.next) return;
    await this.ctx.mutate(
      { action: out.result.empty ? 'time.canvas.empty' : 'time.canvas.preflight', summary: `${out.result.empty ? 'Canvas discarded' : 'Canvas re-rendered'} at Apply: ${preflightSummary(out.result)}`.slice(0, 200), entity: { type: 'draft', id: d.id }, undoable: false },
      async (w, model) => {
        const cur = this.draft(model, d.id);
        await updateDraft(w, cur, { ...out.next!, version: cur.version }, { bump: true });
      },
    );
    this.ctx.bus.publishTables(['drafts'], [d.id], 'time.canvas.preflight');
    throw invalid(out.message!, { draftId: d.id, dropped: out.result.dropped, discarded: out.result.empty });
  }

  async getOutbox(_i: I<'getOutbox'>): Promise<Res<'getOutbox'>> {
    return this.ctx.read(OUTBOX, (m) => buildOutbox(m, m.ctx.me));
  }

  // ---- D-90 (W12-7): the release items (src/outbox/release.ts; db bits in ./outbox-release.ts) -------------------
  async stageRelease({ body }: I<'stageRelease'>): Promise<Res<'stageRelease'>> {
    const save = async (dest: ActionDestination, audit: { action: string; summary: string }, cur?: Draft) => {
      const doc = actionDoc(dest);
      const draft = cur ? { ...cur, destination: dest, doc, plainText: actionSummary(dest), rendered: renderAll(dest, doc), status: 'ready' as const } : actionDraftFor(dest, { id: crypto.randomUUID(), now: this.ctx.now().toISOString(), workItemId: null, rendered: (d) => renderAll(dest, d) });
      await this.ctx.mutate({ action: audit.action, summary: audit.summary.slice(0, 200), entity: { type: 'draft', id: draft.id }, undoable: false }, async (w) => void (cur ? await updateDraft(w, cur, draft, { bump: true }) : await insertDraft(w, draft)));
      this.ctx.bus.publishTables(['drafts'], [draft.id], audit.action);
      return this.draft(await this.ctx.model(WHOLE), draft.id);
    };
    const entity = await stageReleaseItems({ drafts: async () => (await this.ctx.model(WHOLE)).all('drafts'), distribution: async () => releaseDistributionFor(this.ctx.db, await this.ctx.userId()), dryRun: async () => (await this.ctx.model(WHOLE)).settings().sending.dryRun !== false, insert: (dest, audit) => save(dest, audit), replace: (cur, dest, audit) => save(dest, audit, cur) }, body);
    return { entity, auditId: null };
  }

  /** "Mark uploaded" on a release.drive_upload hand-off: status sent, one attempt, a landing; no tool call, no job. */
  private async markReleaseHandedOff(d0: Draft, body: I<'dispatchDraft'>['body']): Promise<Res<'dispatchDraft'>> {
    checkHandoffConfirm(d0, { mode: body.mode, confirmToken: body.confirmToken, expectedToken: this.confirmTokenFor(d0, body.mode), now: this.ctx.now() });
    const payload = payloadFor(d0.destination, d0.doc, body.mode);
    const r = await this.ctx.mutate({ action: 'release.handed_off', summary: `Marked uploaded: ${d0.destination.kind === 'action' ? d0.destination.target.label : 'release'}`.slice(0, 200), entity: { type: 'draft', id: d0.id }, undoable: false }, async (w, model) => {
      const d = this.draft(model, d0.id);
      await updateDraft(w, d, handedOff(d, w.now.toISOString(), '0'), { bump: true, ifVersion: body.ifVersion });
      await recordReleaseLanding(w.tx, w.userId, d, w.now);
    });
    this.ctx.bus.publishTables(['drafts'], [d0.id], 'release.handed_off');
    const d = this.draft(await this.ctx.model(WHOLE), d0.id);
    return { draft: d, dryRun: false, payload, rendition: renditionFor(d.destination, d.doc), attempt: d.attempts[d.attempts.length - 1]!, auditId: r.auditId };
  }
}
